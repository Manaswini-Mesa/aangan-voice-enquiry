import "server-only";
import type { ConversationState } from "@/core/conversation/engine";
import type { Db } from "../db/client";
import { config } from "../env";
import { VaaniClient, type VaaniHistoryCall } from "../providers/voice/vaani";
import { audit, opsEvent, recordIntegrationCheck } from "../repo/ops";
import type { CallRow } from "../repo/types";
import { ensureCall, finalizeInTx } from "./calls";
import { replayTranscript } from "./webhooks";

// Pull-based ingestion from VaaniVoice (no webhook registration needed). Two sources:
//  1. GET /api/call-history — finds calls we have never seen (e.g. inbound phone calls).
//  2. Calls we already know about but haven't finished (e.g. browser test calls created at
//     dispatch) — looked up one by one with GET /api/call_details/{id}. This keeps working
//     even when call-history is unavailable (it returned HTTP 500 for this account on 2026-10-10).
// Each call: store provider transcript/summary → run the SAME deterministic engine over the
// caller's lines → finalize (handoff / review / complaint / follow-ups / notifications).
// Calls our BYOL gateway already handled (turn > 0) are only enriched, never re-qualified.
// Idempotent: a finalized call is never processed again.

export interface SyncResult {
  checked: number;
  ingested: number;
  skipped: number;
  pendingNotifications: string[];
  error?: string;
  historyAvailable: boolean;
}

function callerNumber(c: Partial<VaaniHistoryCall>): string | undefined {
  const inbound = /in/i.test(c.direction ?? c.call_type ?? "");
  const n = inbound ? c.from_number : c.to_number;
  return n && /\d{7,}/.test(n) ? n : undefined;
}

function parseTime(t?: string): Date | null {
  if (!t) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Ingests one VaaniVoice call. Returns notification ids, or null if the transcript isn't ready. */
async function ingestCall(db: Db, client: VaaniClient, c: Partial<VaaniHistoryCall> & { call_id: string }, mode: "live" | "simulated"): Promise<string[] | null> {
  const details = await client.callDetails(c.call_id);
  const transcript = details?.transcription;
  if (!transcript) return null;
  await ensureCall(db, { provider: "vaani", providerCallId: c.call_id, mode }, { callerNumber: callerNumber(c), at: parseTime(c.Start_time) ?? new Date() });
  return db.tx(async (tx) => {
    const call = (await tx.query<CallRow>(`SELECT * FROM calls WHERE provider = 'vaani' AND provider_call_id = $1`, [c.call_id]))[0];
    if (call.finalized_at) return [];
    const endedAt = parseTime(c.End_time);
    await tx.query(
      `UPDATE calls SET provider_summary = COALESCE($2, provider_summary), provider_transcript = COALESCE($3, provider_transcript),
         status = CASE WHEN status = 'active' THEN 'completed' ELSE status END, ended_at = COALESCE(ended_at, $4, now()),
         duration_sec = COALESCE(duration_sec, $5), end_reason = COALESCE(end_reason, $6) WHERE id = $1`,
      [call.id, details?.summary ?? c.call_summary ?? null, transcript, endedAt?.toISOString() ?? null, c.duration_ms !== undefined ? Math.round(c.duration_ms) / 1000 : null, c.call_status ?? null],
    );
    if (typeof c.call_cost === "number") {
      await tx.query(
        `INSERT INTO usage_events (lead_id, call_id, provider, kind, quantity, unit, cost_amount, cost_currency, cost_type, mode, metadata, idempotency_key)
         VALUES ($1,$2,'vaani','voice_call',1,'calls',$3,'VAANI_CREDITS','actual',$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING`,
        [call.lead_id, call.id, c.call_cost, mode, JSON.stringify({ source: "call-history call_cost", duration_ms: c.duration_ms }), `vaani-cost:${c.call_id}`],
      );
    }
    const state = call.conversation_state as ConversationState;
    if (state.turn === 0) await replayTranscript(tx, call, transcript);
    return finalizeInTx(tx, call.id);
  });
}

export async function syncVaaniCalls(db: Db, opts: { maxPages?: number } = {}): Promise<SyncResult> {
  const cfg = config();
  const result: SyncResult = { checked: 0, ingested: 0, skipped: 0, pendingNotifications: [], historyAvailable: true };
  if (!cfg.vaani.apiKey || !cfg.vaani.agentId) {
    result.error = "VAANI_API_KEY and VAANI_AGENT_ID must be set to sync calls.";
    return result;
  }
  const client = new VaaniClient(cfg.vaani.apiKey, cfg.vaani.baseUrl);
  const handled = new Set<string>();

  // 1) Call history
  for (let page = 1; page <= (opts.maxPages ?? 3); page++) {
    const history = await client.callHistory(page, 50).catch(() => null);
    if (!history) {
      result.historyAvailable = false;
      await opsEvent(db, "warn", "vaani_sync", "HISTORY_UNAVAILABLE", "VaaniVoice call-history API did not respond successfully; known calls are still checked individually.");
      break;
    }
    for (const c of history.data) {
      if (c.agent_id !== cfg.vaani.agentId) continue;
      result.checked++;
      handled.add(c.call_id);
      const existing = (await db.query<CallRow>(`SELECT * FROM calls WHERE provider = 'vaani' AND provider_call_id = $1`, [c.call_id]))[0];
      if (existing?.finalized_at || (c.post_processing_status && c.post_processing_status !== "completed")) {
        result.skipped++;
        continue;
      }
      try {
        const ids = await ingestCall(db, client, c, existing?.mode ?? "live");
        if (ids === null) result.skipped++;
        else {
          result.ingested++;
          result.pendingNotifications.push(...ids);
        }
      } catch (err) {
        await opsEvent(db, "error", "vaani_sync", "CALL_SYNC_FAILED", `Could not ingest a VaaniVoice call: ${(err as Error).message.slice(0, 160)}`, null, { callId: c.call_id });
      }
    }
    if (!history.hasNext) break;
  }

  // 2) Known but unfinished calls (last 2 days)
  const known = await db.query<{ provider_call_id: string; mode: "live" | "simulated" }>(
    `SELECT provider_call_id, mode FROM calls WHERE provider = 'vaani' AND finalized_at IS NULL AND created_at > now() - interval '2 days' ORDER BY created_at DESC LIMIT 25`,
  );
  for (const k of known) {
    if (handled.has(k.provider_call_id)) continue;
    result.checked++;
    try {
      const ids = await ingestCall(db, client, { call_id: k.provider_call_id }, k.mode);
      if (ids === null) result.skipped++;
      else {
        result.ingested++;
        result.pendingNotifications.push(...ids);
      }
    } catch (err) {
      await opsEvent(db, "error", "vaani_sync", "CALL_SYNC_FAILED", `Could not ingest a VaaniVoice call: ${(err as Error).message.slice(0, 160)}`, null, { callId: k.provider_call_id });
    }
  }

  const detail = `Checked ${result.checked}, ingested ${result.ingested}.${result.historyAvailable ? "" : " Call-history API unavailable; only known calls checked."}`;
  await recordIntegrationCheck(db, "voice_sync", result.historyAvailable ? "ok" : "partial", detail);
  await audit(db, { label: "vaani_sync" }, "vaani.sync", "system", "vaani", null, undefined, { checked: result.checked, ingested: result.ingested, historyAvailable: result.historyAvailable });
  return result;
}

/**
 * Ingest one call by ID (used by the notification webhook). The ID is untrusted: we only act on
 * data fetched from VaaniVoice with our own API key, so a forged notification cannot create
 * records — VaaniVoice simply won't return details for a call that isn't in our account.
 */
export async function ingestVaaniCallById(db: Db, callId: string): Promise<{ status: "ingested" | "already" | "not_ready"; pendingNotifications: string[] }> {
  const cfg = config();
  if (!cfg.vaani.apiKey) return { status: "not_ready", pendingNotifications: [] };
  const existing = (await db.query<CallRow>(`SELECT * FROM calls WHERE provider = 'vaani' AND provider_call_id = $1`, [callId]))[0];
  if (existing?.finalized_at) return { status: "already", pendingNotifications: [] };
  const client = new VaaniClient(cfg.vaani.apiKey, cfg.vaani.baseUrl);
  const ids = await ingestCall(db, client, { call_id: callId }, existing?.mode ?? "live");
  return ids === null ? { status: "not_ready", pendingNotifications: [] } : { status: "ingested", pendingNotifications: ids };
}
