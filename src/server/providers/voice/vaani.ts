// VaaniVoice adapter — implemented strictly from https://docs.vaanivoice.ai (checked 2026-10-10):
//  * REST base https://api.vaanivoice.ai, auth header X-API-Key
//      GET /api/agents                   (used to verify the key)
//      GET /api/call_details/{call_id}   (transcript, entities, summary)
//  * Webhooks (Settings → Webhooks): JSON POST per lifecycle event. Events for inbound calls:
//      call_started, user_picked_up_at, human_transfer_initiated|successful|failed,
//      call_ended (call_duration in SECONDS), call_postprocessing (call_duration in MILLISECONDS)
//    The docs describe NO signature scheme, so authenticity is enforced with a secret token in
//    the webhook URL path (see app/api/webhooks/vaani/[token]).
//  * BYOL ("Bring your own LLM"): Vaani opens a WebSocket to <url>/<call_id> per call and sends
//    {interaction_type:"response_required", response_id, call_id, transcript[], req_body} each turn.
//    We stream back {response_type:"response", response_id, content, content_complete, end_call?}.
// No other endpoints are assumed. This file has no framework imports so the voice gateway can use it.

export interface NormalizedVoiceEvent {
  type:
    | "call_started"
    | "call_answered"
    | "call_ended"
    | "call_postprocessing"
    | "transfer_initiated"
    | "transfer_succeeded"
    | "transfer_failed"
    | "call_failed"
    | "other";
  rawType: string;
  providerCallId?: string;
  phoneNumber?: string;
  durationSec?: number;
  endReason?: string;
  summary?: string;
  transcript?: string;
  entities?: Record<string, unknown>;
  recordingUrl?: string;
  timestamp?: string;
}

function s(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function n(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;
}

/** Normalises the documented payload shapes (flat, and `data`-nested for call_postprocessing). */
export function normalizeVaaniWebhook(payload: unknown): NormalizedVoiceEvent {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const data = (p.data && typeof p.data === "object" ? p.data : {}) as Record<string, unknown>;
  const rawType = s(p.event) ?? "unknown";
  const providerCallId = s(p.room_name) ?? s(p.call_id) ?? s(data.room_name) ?? s(data.call_id);
  const base = { rawType, providerCallId, timestamp: s(p.timestamp) };
  switch (rawType) {
    case "call_started":
      return { ...base, type: "call_started", phoneNumber: s(p.phone_number) };
    case "user_picked_up_at":
      return { ...base, type: "call_answered" };
    case "call_ended":
      return { ...base, type: "call_ended", durationSec: n(p.call_duration), endReason: s(p.end_reason) };
    case "call_postprocessing": {
      const ms = n(data.call_duration) ?? n(p.call_duration);
      return {
        ...base,
        type: "call_postprocessing",
        durationSec: ms !== undefined ? Math.round(ms / 100) / 10 : undefined,
        endReason: s(data.end_reason),
        summary: s(data.summary),
        transcript: s(data.transcript),
        entities: data.entities && typeof data.entities === "object" ? (data.entities as Record<string, unknown>) : undefined,
        recordingUrl: s(data.recording_url),
      };
    }
    case "human_transfer_initiated":
      return { ...base, type: "transfer_initiated", phoneNumber: s(p.phone_number) };
    case "human_transfer_successful":
      return { ...base, type: "transfer_succeeded", phoneNumber: s(p.phone_number) };
    case "human_transfer_failed":
      return { ...base, type: "transfer_failed", phoneNumber: s(p.phone_number), endReason: s(p.reason) };
    case "call_failed":
      return { ...base, type: "call_failed", endReason: s(p.error) };
    default:
      return { ...base, type: "other" };
  }
}

/** Stable idempotency key for a webhook delivery (same event for same call → same key). */
export function webhookEventKey(e: NormalizedVoiceEvent, payload: unknown): string {
  const ts = e.timestamp ?? "";
  if (e.providerCallId) return `vaani:${e.rawType}:${e.providerCallId}:${ts}`;
  return `vaani:${e.rawType}:${hashString(JSON.stringify(payload ?? null))}`;
}

function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Parses the provider's plain-text transcript "[hh:mm:ss] AGENT: ...\n\n[..] USER: ..." */
export function parseVaaniTranscript(text: string): Array<{ speaker: "caller" | "agent"; text: string }> {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(?:\[[^\]]*\]\s*)?(AGENT|USER|ASSISTANT|CALLER)\s*:\s*(.*)$/i);
      if (!m) return null;
      return { speaker: /USER|CALLER/i.test(m[1]) ? ("caller" as const) : ("agent" as const), text: m[2].trim() };
    })
    .filter((x): x is { speaker: "caller" | "agent"; text: string } => !!x && !!x.text);
}

// ---------- BYOL WebSocket protocol ----------

export interface ByolRequest {
  interaction_type: string;
  response_id?: number;
  call_id?: string;
  transcript?: Array<{ role: string; content: string }>;
  req_body?: { contact_number?: string } & Record<string, unknown>;
}

export const BYOL_HANDSHAKE = [
  { interaction_type: "config", content: "Server ready" },
  { interaction_type: "greeting", content: "Hello" },
] as const;

export function parseByolMessage(raw: string): ByolRequest | { pingPong: true } | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (msg.response_type === "ping_pong" || msg.interaction_type === "ping_pong") return { pingPong: true };
    if (typeof msg.interaction_type !== "string") return null;
    return msg as unknown as ByolRequest;
  } catch {
    return null;
  }
}

/** Caller text for this turn = every user message after the last assistant message, de-duplicated. */
export function latestCallerText(transcript: ByolRequest["transcript"]): string {
  if (!Array.isArray(transcript)) return "";
  const out: string[] = [];
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m.role === "assistant" || m.role === "agent" || m.role === "system") break;
    if (m.role === "user" && typeof m.content === "string" && !out.includes(m.content.trim())) out.unshift(m.content.trim());
  }
  return out.join(" ").trim();
}

export function byolResponseFrame(responseId: number, content: string, endCall: boolean) {
  return { response_type: "response", response_id: responseId, content, content_complete: true, ...(endCall ? { end_call: true } : {}) };
}

// ---------- REST client ----------

export class VaaniClient {
  constructor(
    private apiKey: string,
    private baseUrl = "https://api.vaanivoice.ai",
  ) {}

  private async get<T>(path: string): Promise<{ status: number; body: T | null }> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { "X-API-Key": this.apiKey }, signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => null)) as T | null;
    return { status: res.status, body };
  }

  async verify(agentId?: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const { status, body } = await this.get<unknown>("/api/agents");
      if (status === 401 || status === 403) return { ok: false, detail: `API key rejected (${status}).` };
      if (status !== 200) return { ok: false, detail: `Vaani API responded ${status}.` };
      const list = Array.isArray(body) ? body : Array.isArray((body as { agents?: unknown[] })?.agents) ? (body as { agents: unknown[] }).agents : [];
      if (agentId) {
        const found = list.some((a) => JSON.stringify(a).includes(agentId));
        return { ok: found, detail: found ? `API key valid; agent ${agentId.slice(0, 8)}… found.` : "API key valid, but VAANI_AGENT_ID was not found in this account." };
      }
      return { ok: true, detail: `API key valid; ${list.length} agent(s) visible. Set VAANI_AGENT_ID to check a specific agent.` };
    } catch {
      return { ok: false, detail: "Could not reach api.vaanivoice.ai." };
    }
  }

  async callDetails(callId: string): Promise<{ transcription?: string; summary?: string; entity?: unknown } | null> {
    const { status, body } = await this.get<{ transcription?: string; summary?: string; entity?: unknown }>(`/api/call_details/${encodeURIComponent(callId)}`);
    if (status !== 200 || !body) return null;
    if (typeof body.transcription === "string" && body.transcription.startsWith("Transcript is not available")) return null;
    return body;
  }
}
