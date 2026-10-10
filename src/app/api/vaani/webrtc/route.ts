import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { config } from "@/server/env";
import { VaaniClient } from "@/server/providers/voice/vaani";
import { rateLimit } from "@/server/rate-limit";
import { opsEvent } from "@/server/repo/ops";
import { ensureCall } from "@/server/services/calls";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Starts an in-browser voice session with the real VaaniVoice agent (WebRTC via LiveKit).
// The API key stays on the server; the browser receives only the short-lived room token.
// These are staff test calls, so the call is recorded as "simulated": it is labelled as a
// test, excluded from live metrics, and its notifications never reach real inboxes.
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(user.role, "simulator:use")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!rateLimit(`webrtc:${user.id}`, 5, 60_000).ok) return NextResponse.json({ error: "Too many test calls — wait a minute." }, { status: 429 });
  const cfg = config();
  if (!cfg.vaani.apiKey || !cfg.vaani.agentId) return NextResponse.json({ error: "VaaniVoice is not configured (VAANI_API_KEY, VAANI_AGENT_ID)." }, { status: 503 });
  const db = await getDb();
  try {
    const s = await new VaaniClient(cfg.vaani.apiKey, cfg.vaani.baseUrl).startWebrtcSession(cfg.vaani.agentId);
    await ensureCall(db, { provider: "vaani", providerCallId: s.roomName, mode: "simulated" }, { at: new Date() });
    return NextResponse.json({ token: s.token, connectionUrl: s.connectionUrl, roomName: s.roomName, liveCaptionsUrl: s.liveCaptionsUrl ?? null });
  } catch (err) {
    await opsEvent(db, "error", "vaani_webrtc", "DISPATCH_FAILED", (err as Error).message.slice(0, 200));
    return NextResponse.json({ error: "VaaniVoice could not start a session. Check Integrations." }, { status: 502 });
  }
}

/** Status of a browser test call: has it been ingested and qualified yet? */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || !can(user.role, "simulator:use")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const room = new URL(req.url).searchParams.get("room") ?? "";
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(room)) return NextResponse.json({ error: "invalid room" }, { status: 400 });
  const db = await getDb();
  const r = (await db.query<{ lead_id: string; finalized_at: string | null; ref: string; status: string; disposition: string | null }>(
    `SELECT c.lead_id, c.finalized_at, l.ref, l.status, l.disposition FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.provider = 'vaani' AND c.provider_call_id = $1`,
    [room],
  ))[0];
  if (!r) return NextResponse.json({ found: false });
  return NextResponse.json({ found: true, leadId: r.lead_id, leadRef: r.ref, finalized: !!r.finalized_at, status: r.status, disposition: r.disposition });
}
