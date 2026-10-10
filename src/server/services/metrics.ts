import "server-only";
import { costSummary, responseStats, type CostSummary, type ResponseStats, type UsageRecord } from "@/core/metrics";
import type { Db } from "../db/client";

export interface DateRange {
  from: Date;
  to: Date;
  includeSimulated: boolean;
}

export function parseRange(params: { range?: string; from?: string; to?: string; sim?: string }, defaultIncludeSimulated: boolean): DateRange & { label: string } {
  const now = new Date();
  const days: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
  const includeSimulated = params.sim === undefined ? defaultIncludeSimulated : params.sim === "1";
  if (params.from || params.to) {
    const from = params.from ? new Date(`${params.from}T00:00:00+05:30`) : new Date(0);
    const to = params.to ? new Date(`${params.to}T23:59:59+05:30`) : now;
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) return { from, to, includeSimulated, label: "custom" };
  }
  const key = params.range && (days[params.range] || params.range === "all") ? params.range : "30d";
  const from = key === "all" ? new Date(0) : new Date(now.getTime() - days[key] * 86_400_000);
  return { from, to: now, includeSimulated, label: key };
}

const simFilter = (alias: string, include: boolean) => (include ? "" : ` AND NOT ${alias}.is_simulated`);

export interface Overview {
  totals: Record<string, number>;
  total: number;
  outsideHours: number;
  complaints: number;
  pendingHandoffs: number;
  openFollowUps: number;
  overdueFollowUps: number;
  awaitingReview: number;
  failedNotifications: number;
  response: ResponseStats;
  calls: { count: number; avgDurationSec: number | null; disconnected: number; live: number; simulated: number };
  ops: { failedWebhooks: number; errors: number };
  costs: CostSummary;
  llmTokens: number;
  voiceMinutes: number;
  emailsSent: number;
}

export async function getOverview(db: Db, r: DateRange): Promise<Overview> {
  const p = [r.from.toISOString(), r.to.toISOString()];
  const sf = simFilter("l", r.includeSimulated);
  const byStatus = await db.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM leads l WHERE created_at BETWEEN $1 AND $2${sf} GROUP BY status`,
    p,
  );
  const totals = Object.fromEntries(byStatus.map((s) => [s.status, Number(s.n)]));
  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  const one = async (sql: string, params: unknown[] = p) => Number((await db.query<{ n: string }>(sql, params))[0]?.n ?? 0);

  const outsideHours = await one(`SELECT count(*)::text AS n FROM leads l WHERE outside_hours AND created_at BETWEEN $1 AND $2${sf}`);
  const complaints = await one(`SELECT count(*)::text AS n FROM complaints c JOIN leads l ON l.id = c.lead_id WHERE c.created_at BETWEEN $1 AND $2${sf}`);
  // Work queues are "as of now" regardless of the date filter.
  const sfNow = simFilter("l", r.includeSimulated);
  const pendingHandoffs = await one(`SELECT count(*)::text AS n FROM handoffs h JOIN leads l ON l.id = h.lead_id WHERE h.status IN ('pending_assignment','assigned')${sfNow}`, []);
  const openFollowUps = await one(`SELECT count(*)::text AS n FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.status = 'open'${sfNow}`, []);
  const overdueFollowUps = await one(`SELECT count(*)::text AS n FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.status = 'open' AND f.due_at < now()${sfNow}`, []);
  const awaitingReview = await one(`SELECT count(*)::text AS n FROM leads l WHERE status = 'review'${sfNow}`, []);
  const failedNotifications = await one(
    `SELECT count(*)::text AS n FROM notifications n LEFT JOIN leads l ON l.id = n.lead_id WHERE n.status IN ('failed','not_configured','pending')${r.includeSimulated ? "" : " AND (l.id IS NULL OR NOT l.is_simulated)"}`,
    [],
  );

  const resp = await db.query<{ first_contact_at: string; first_response_at: string | null }>(
    `SELECT first_contact_at, first_response_at FROM leads l WHERE created_at BETWEEN $1 AND $2 AND enquiry_type = 'new_enquiry'${sf}`,
    p,
  );
  const callRows = await db.query<{ n: string; avg: string | null; disc: string; live: string; sim: string }>(
    `SELECT count(*)::text AS n, avg(duration_sec)::text AS avg,
            count(*) FILTER (WHERE c.status = 'disconnected')::text AS disc,
            count(*) FILTER (WHERE c.mode = 'live')::text AS live,
            count(*) FILTER (WHERE c.mode = 'simulated')::text AS sim
     FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.started_at BETWEEN $1 AND $2${sf}`,
    p,
  );
  const failedWebhooks = await one(`SELECT count(*)::text AS n FROM webhook_events WHERE status = 'failed' AND received_at BETWEEN $1 AND $2`);
  const errors = await one(`SELECT count(*)::text AS n FROM ops_events WHERE level = 'error' AND created_at BETWEEN $1 AND $2`);
  const usage = await db.query<UsageRecord & { mode: string }>(
    `SELECT u.provider, u.kind, u.quantity, u.unit, u.cost_amount, u.cost_currency, u.cost_type, u.mode
     FROM usage_events u LEFT JOIN leads l ON l.id = u.lead_id
     WHERE u.created_at BETWEEN $1 AND $2${r.includeSimulated ? "" : " AND (l.id IS NULL OR NOT l.is_simulated)"}`,
    p,
  );
  const sum = (kind: string) => usage.filter((u) => u.kind === kind).reduce((a, u) => a + Number(u.quantity), 0);
  return {
    totals,
    total,
    outsideHours,
    complaints,
    pendingHandoffs,
    openFollowUps,
    overdueFollowUps,
    awaitingReview,
    failedNotifications,
    response: responseStats(resp),
    calls: {
      count: Number(callRows[0]?.n ?? 0),
      avgDurationSec: callRows[0]?.avg ? Math.round(Number(callRows[0].avg)) : null,
      disconnected: Number(callRows[0]?.disc ?? 0),
      live: Number(callRows[0]?.live ?? 0),
      simulated: Number(callRows[0]?.sim ?? 0),
    },
    ops: { failedWebhooks, errors },
    costs: costSummary(usage),
    llmTokens: sum("llm_tokens"),
    voiceMinutes: sum("voice_minutes"),
    emailsSent: sum("email"),
  };
}

export async function dailyEnquiries(db: Db, r: DateRange): Promise<Array<{ day: string; total: number; qualified: number }>> {
  return (
    await db.query<{ day: string; total: string; qualified: string }>(
      `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day, count(*)::text AS total,
              count(*) FILTER (WHERE status IN ('qualified','handed_off'))::text AS qualified
       FROM leads l WHERE created_at BETWEEN $1 AND $2${simFilter("l", r.includeSimulated)} GROUP BY 1 ORDER BY 1`,
      [r.from.toISOString(), r.to.toISOString()],
    )
  ).map((d) => ({ day: d.day, total: Number(d.total), qualified: Number(d.qualified) }));
}
