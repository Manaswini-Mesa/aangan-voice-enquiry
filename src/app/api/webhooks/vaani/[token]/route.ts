import { after, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/server/bootstrap";
import { getDb } from "@/server/db/client";
import { config } from "@/server/env";
import { clientIp, rateLimit, safeEqual } from "@/server/rate-limit";
import { afterCallWork } from "@/server/services/calls";
import { processVaaniWebhook } from "@/server/services/webhooks";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// VaaniVoice webhook receiver. VaaniVoice documents no signature header, so the endpoint is
// authenticated by an unguessable token in the URL path (VAANI_WEBHOOK_TOKEN), compared in
// constant time. Register: https://<your-app>/api/webhooks/vaani/<VAANI_WEBHOOK_TOKEN>
// Events are de-duplicated on a stable key, so retries never create duplicate records.

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const expected = config().vaani.webhookToken;
  if (!expected || !safeEqual(token, expected)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!rateLimit(`webhook:${clientIp(req.headers)}`, 300, 60_000).ok) return NextResponse.json({ error: "rate limited" }, { status: 429 });

  const text = await req.text();
  if (text.length > 1_000_000) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    await ensureBootstrapped();
    const db = await getDb();
    const outcome = await processVaaniWebhook(db, payload);
    if (outcome.pendingNotifications.length || outcome.callId) after(() => afterCallWork(db, outcome.callId, outcome.pendingNotifications));
    // 500 on processing failure so the provider may retry; duplicates are acknowledged with 200.
    return NextResponse.json({ status: outcome.status }, { status: outcome.status === "failed" ? 500 : 200 });
  } catch {
    console.error(JSON.stringify({ level: "error", source: "vaani_webhook", code: "UNAVAILABLE" }));
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
}
