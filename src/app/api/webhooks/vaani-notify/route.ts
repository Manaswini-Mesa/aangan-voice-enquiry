import { after, NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { normalizeVaaniWebhook } from "@/server/providers/voice/vaani";
import { clientIp, rateLimit } from "@/server/rate-limit";
import { opsEvent } from "@/server/repo/ops";
import { dispatchPending } from "@/server/services/notifications";
import { ingestVaaniCallById } from "@/server/services/vaani-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Secret-free VaaniVoice webhook ("notification" style). The payload is treated purely as a hint:
// we take only the call ID and then fetch the authoritative call details from VaaniVoice with our
// own API key. Nothing in the payload is stored or trusted, so the URL needs no secret token.
// Register in VaaniVoice → Developers → Webhooks:  https://<app>/api/webhooks/vaani-notify

export async function POST(req: Request) {
  if (!rateLimit(`vaani-notify:${clientIp(req.headers)}`, 120, 60_000).ok) return NextResponse.json({ error: "rate limited" }, { status: 429 });
  const text = await req.text();
  if (text.length > 1_000_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const e = normalizeVaaniWebhook(payload);
  const callId = e.providerCallId;
  if (!callId || !/^[A-Za-z0-9._:-]{1,200}$/.test(callId)) return NextResponse.json({ status: "ignored" });
  // Only end-of-call events can have a transcript to fetch.
  if (e.type !== "call_ended" && e.type !== "call_postprocessing") return NextResponse.json({ status: "noted", event: e.rawType });
  after(async () => {
    const db = await getDb();
    try {
      const r = await ingestVaaniCallById(db, callId);
      if (r.pendingNotifications.length) await dispatchPending(db, r.pendingNotifications);
    } catch (err) {
      await opsEvent(db, "error", "vaani_notify", "INGEST_FAILED", `Webhook-triggered ingest failed: ${(err as Error).message.slice(0, 160)}`, null, { callId });
    }
  });
  return NextResponse.json({ status: "accepted" });
}
