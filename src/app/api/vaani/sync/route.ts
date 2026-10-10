import { after, NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { rateLimit } from "@/server/rate-limit";
import { dispatchPending } from "@/server/services/notifications";
import { syncVaaniCalls } from "@/server/services/vaani-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Staff-triggered pull of finished calls from VaaniVoice (also runs in the daily cron). */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(user.role, "leads:edit")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!rateLimit(`vaani-sync:${user.id}`, 6, 60_000).ok) return NextResponse.json({ error: "Please wait a moment before syncing again." }, { status: 429 });
  const db = await getDb();
  const r = await syncVaaniCalls(db);
  if (r.pendingNotifications.length) after(() => dispatchPending(db, r.pendingNotifications));
  return NextResponse.json({ checked: r.checked, ingested: r.ingested, skipped: r.skipped, historyAvailable: r.historyAvailable, error: r.error }, { status: r.error ? 502 : 200 });
}
