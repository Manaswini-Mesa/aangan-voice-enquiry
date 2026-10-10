import { NextResponse } from "next/server";
import { formatIst } from "@/core/time";
import { getDb } from "@/server/db/client";
import { config, dashboardUrl } from "@/server/env";
import { safeEqual } from "@/server/rate-limit";
import { createNotification, dispatchPending } from "@/server/services/notifications";
import { overdueEmail } from "@/server/services/notification-templates";
import { finalizeStaleCalls } from "@/server/services/webhooks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Periodic maintenance (Vercel Cron sends "Authorization: Bearer <CRON_SECRET>"):
//  - finalizes calls that ended without finalization,
//  - retries notifications still pending (never re-sends delivered ones),
//  - emails an overdue follow-up digest to NOTIFY_OPS_TO (once per day).
export async function GET(req: Request) {
  const secret = config().cronSecret;
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || !safeEqual(auth, secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = await getDb();
  const stale = await finalizeStaleCalls(db);
  const pending = await db.query<{ id: string }>(
    `SELECT id FROM notifications WHERE status = 'pending' AND created_at < now() - interval '2 minutes' AND attempts < 5 ORDER BY created_at LIMIT 50`,
  );
  await dispatchPending(db, [...stale.pending, ...pending.map((p) => p.id)]);
  let digest = false;
  const ops = config().email.opsTo;
  if (ops.length) {
    const overdue = await db.query<{ ref: string; kind: string; due_at: string }>(
      `SELECT l.ref, f.kind, f.due_at FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.status = 'open' AND f.due_at < now() AND NOT l.is_simulated ORDER BY f.due_at LIMIT 50`,
    );
    if (overdue.length) {
      const day = new Date().toISOString().slice(0, 10);
      const id = await createNotification(db, {
        leadId: null,
        kind: "ops_overdue",
        recipients: ops,
        content: overdueEmail(overdue.map((o) => ({ ref: o.ref, kind: o.kind, due: formatIst(o.due_at) })), dashboardUrl("/workspace")),
        idempotencyKey: `overdue:${day}`,
      });
      if (id) {
        await dispatchPending(db, [id]);
        digest = true;
      }
    }
  }
  return NextResponse.json({ finalized: stale.finalized, retried: pending.length, digest });
}
