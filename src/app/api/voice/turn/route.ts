import { after, NextResponse } from "next/server";
import { z } from "zod";
import { ensureBootstrapped } from "@/server/bootstrap";
import { DatabaseUnavailableError, getDb } from "@/server/db/client";
import { config } from "@/server/env";
import { rateLimit, safeEqual } from "@/server/rate-limit";
import { opsEvent } from "@/server/repo/ops";
import { afterCallWork, endCall, ensureCall, handleCallerTurn } from "@/server/services/calls";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Called by the voice gateway (voice-gateway/server.ts), which terminates VaaniVoice's BYOL
// WebSocket. Authenticated with VOICE_GATEWAY_SECRET (Bearer). Each turn is idempotent on
// (callId, responseId), so a retried frame returns the same reply without re-processing.

const Body = z.object({
  event: z.enum(["start", "turn", "disconnect"]),
  callId: z.string().min(1).max(200),
  responseId: z.number().int().nonnegative().optional(),
  text: z.string().max(4000).optional(),
  callerNumber: z.string().max(30).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const FALLBACK_REPLY = "I'm sorry, I'm having a little trouble on my side. Could you say that once more?";

export async function POST(req: Request) {
  const secret = config().vaani.gatewaySecret;
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || !safeEqual(auth, secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const b = parsed.data;
  if (!rateLimit(`turn:${b.callId}`, 120, 60_000).ok) return NextResponse.json({ error: "rate limited" }, { status: 429 });

  const key = { provider: "vaani", providerCallId: b.callId, mode: "live" as const };
  try {
    await ensureBootstrapped();
    const db = await getDb();
    if (b.event === "start") {
      const r = await ensureCall(db, key, { callerNumber: b.callerNumber, at: new Date() });
      return NextResponse.json({ reply: r.greeting, endCall: false, leadRef: r.lead.ref });
    }
    if (b.event === "disconnect") {
      const r = await endCall(db, key, { reason: "websocket_closed" });
      after(() => afterCallWork(db, r.callId, r.pendingNotifications));
      return NextResponse.json({ ok: true, found: r.found });
    }
    const r = await handleCallerTurn(db, {
      ...key,
      text: b.text ?? "",
      confidence: b.confidence,
      callerNumber: b.callerNumber,
      turnKey: b.responseId !== undefined ? `r${b.responseId}` : undefined,
    });
    if (r.endCall) after(() => afterCallWork(db, r.callId, r.pendingNotifications));
    return NextResponse.json({ reply: r.reply, endCall: r.endCall, stage: r.stage });
  } catch (err) {
    const dbDown = err instanceof DatabaseUnavailableError;
    try {
      if (!dbDown) await opsEvent(await getDb(), "error", "voice_turn", "TURN_FAILED", `Turn processing failed: ${(err as Error).message.slice(0, 200)}`);
    } catch {
      /* database itself unavailable */
    }
    console.error(JSON.stringify({ level: "error", source: "voice_turn", code: dbDown ? "DB_UNAVAILABLE" : "TURN_FAILED" }));
    // Keep the caller on the line with a safe, non-committal reply. Never claims any outcome.
    return NextResponse.json({ reply: FALLBACK_REPLY, endCall: false, degraded: true }, { status: 200 });
  }
}
