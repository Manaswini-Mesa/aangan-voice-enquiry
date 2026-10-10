import "server-only";
import type { CurrentUser } from "../auth/session";
import { can, canViewLead } from "../auth/permissions";
import type { Db } from "../db/client";
import type { CallRow, LeadRow, NotificationRow, SegmentRow } from "./types";

// Read models for dashboard pages. Visibility rules are applied here, server-side.

function visibility(user: CurrentUser, alias = "l", paramIndex: number): { sql: string; params: unknown[] } {
  if (can(user.role, "leads:view_all")) return { sql: "", params: [] };
  return { sql: ` AND ${alias}.assigned_designer_id = $${paramIndex}`, params: [user.id] };
}

export interface LeadFilters {
  q?: string;
  status?: string;
  from?: string;
  to?: string;
  locality?: string;
  type?: string;
  assigned?: string;
  sim?: string;
  page?: number;
}

export async function listLeads(db: Db, user: CurrentUser, f: LeadFilters) {
  const where: string[] = ["1=1"];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (f.q) {
    const q = `%${f.q.trim().toLowerCase()}%`;
    params.push(q);
    const i = params.length;
    where.push(`(lower(coalesce(l.caller_name,'')) LIKE $${i} OR lower(l.ref) LIKE $${i} OR coalesce(l.phone_normalized,'') LIKE $${i} OR lower(coalesce(l.locality,'')) LIKE $${i} OR lower(coalesce(l.email,'')) LIKE $${i})`);
  }
  if (f.status === "declined") where.push(`l.status IN ('declined','not_qualified')`);
  else if (f.status === "qualified") where.push(`l.status IN ('qualified','handed_off')`);
  else if (f.status) add(`l.status = ?`, f.status);
  if (f.from) add(`l.created_at >= ?`, new Date(`${f.from}T00:00:00+05:30`).toISOString());
  if (f.to) add(`l.created_at <= ?`, new Date(`${f.to}T23:59:59+05:30`).toISOString());
  if (f.locality) add(`lower(l.locality) = lower(?)`, f.locality);
  if (f.type) add(`l.project_category = ?`, f.type);
  if (f.assigned === "none") where.push(`l.assigned_designer_id IS NULL`);
  else if (f.assigned) add(`l.assigned_designer_id = ?`, f.assigned);
  if (f.sim === "0") where.push(`NOT l.is_simulated`);
  if (f.sim === "only") where.push(`l.is_simulated`);
  const vis = visibility(user, "l", params.length + 1);
  params.push(...vis.params);
  const page = Math.max(1, f.page ?? 1);
  const rows = await db.query<LeadRow & { designer_name: string | null; total_count: string }>(
    `SELECT l.*, u.name AS designer_name, count(*) OVER()::text AS total_count
     FROM leads l LEFT JOIN users u ON u.id = l.assigned_designer_id
     WHERE ${where.join(" AND ")}${vis.sql}
     ORDER BY l.created_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`,
    params,
  );
  return { rows, total: Number(rows[0]?.total_count ?? 0), page };
}

export async function filterOptions(db: Db) {
  const localities = await db.query<{ locality: string }>(`SELECT DISTINCT locality FROM leads WHERE locality IS NOT NULL ORDER BY locality`);
  const designers = await db.query<{ id: string; name: string }>(`SELECT id, name FROM users WHERE active ORDER BY name`);
  return { localities: localities.map((l) => l.locality), designers };
}

export async function getLeadDetail(db: Db, user: CurrentUser, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const lead = (await db.query<LeadRow & { designer_name: string | null }>(`SELECT l.*, u.name AS designer_name FROM leads l LEFT JOIN users u ON u.id = l.assigned_designer_id WHERE l.id = $1`, [id]))[0];
  if (!lead || !canViewLead(user, lead)) return null;
  const [calls, facts, assessments, handoff, notifications, followUps, complaint, appointment, audit, usage, duplicate] = await Promise.all([
    db.query<CallRow>(`SELECT * FROM calls WHERE lead_id = $1 ORDER BY started_at DESC`, [id]),
    db.query<{ key: string; value: unknown; source: string; confidence: string; validation: string; evidence: string | null; created_at: string; superseded: boolean }>(
      `SELECT key, value, source, confidence, validation, evidence, created_at, superseded FROM facts WHERE lead_id = $1 ORDER BY superseded, key, created_at DESC`,
      [id],
    ),
    db.query<{ id: string; kind: string; rule_version: string; disposition: string; criteria: Array<{ id: string; label: string; state: string; applicable: boolean; reasons: string[]; ruleCode: string; provisionalRule?: string; evidence: Array<{ fact: string; value: unknown; source: string; confidence: number }> }>; review_reasons: Array<{ code: string; message: string; mandatory: boolean }>; precedence_trace: string[]; rationale: string | null; created_at: string; created_by_name: string | null }>(
      `SELECT a.*, u.name AS created_by_name FROM assessments a LEFT JOIN users u ON u.id = a.created_by WHERE a.lead_id = $1 ORDER BY a.created_at DESC`,
      [id],
    ),
    db.query<{ id: string; status: string; brief: Record<string, unknown>; designer_name: string | null; created_at: string; assigned_at: string | null; due_at: string | null }>(
      `SELECT h.*, u.name AS designer_name FROM handoffs h LEFT JOIN users u ON u.id = h.designer_id WHERE h.lead_id = $1`,
      [id],
    ),
    db.query<NotificationRow>(`SELECT * FROM notifications WHERE lead_id = $1 ORDER BY created_at DESC`, [id]),
    db.query<{ id: string; kind: string; status: string; due_at: string | null; notes: string | null; outcome: string | null; created_at: string; completed_at: string | null }>(
      `SELECT * FROM follow_ups WHERE lead_id = $1 ORDER BY status = 'open' DESC, due_at`,
      [id],
    ),
    db.query<{ id: string; status: string; summary: string; designer_name: string | null; client_name: string | null; created_at: string; resolution: string | null }>(`SELECT * FROM complaints WHERE lead_id = $1`, [id]),
    db.query<{ id: string; status: string; preferred_text: string | null; provider: string; confirmation_ref: string | null; notes: string | null; updated_at: string }>(`SELECT * FROM appointments WHERE lead_id = $1`, [id]),
    db.query<{ actor_label: string; action: string; before: unknown; after: unknown; created_at: string }>(`SELECT actor_label, action, before, after, created_at FROM audit_log WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 100`, [id]),
    db.query<{ provider: string; kind: string; quantity: string; unit: string; cost_amount: string | null; cost_currency: string | null; cost_type: string; metadata: Record<string, unknown> }>(`SELECT * FROM usage_events WHERE lead_id = $1 ORDER BY created_at`, [id]),
    lead.possible_duplicate_of ? db.query<{ id: string; ref: string }>(`SELECT id, ref FROM leads WHERE id = $1`, [lead.possible_duplicate_of]) : Promise.resolve([]),
  ]);
  const segments = calls.length
    ? await db.query<SegmentRow>(`SELECT * FROM transcript_segments WHERE call_id = ANY($1::uuid[]) ORDER BY call_id, seq`, [calls.map((c) => c.id)])
    : [];
  return { lead, calls, segments, facts, assessments, handoff: handoff[0], notifications, followUps, complaint: complaint[0], appointment: appointment[0], audit, usage, duplicate: duplicate[0] };
}

export async function reviewQueue(db: Db) {
  return db.query<LeadRow & { reason_codes: string }>(`SELECT l.* FROM leads l WHERE l.status = 'review' ORDER BY l.created_at`);
}

export async function workspace(db: Db, user: CurrentUser) {
  const vis = can(user.role, "leads:view_all") ? "" : " AND l.assigned_designer_id = $1";
  const p = can(user.role, "leads:view_all") ? [] : [user.id];
  const [handoffs, followUps, notifications, appointments] = await Promise.all([
    db.query<{ id: string; lead_id: string; status: string; designer_name: string | null; created_at: string; due_at: string | null; ref: string; caller_name: string | null; locality: string | null; scope_summary: string | null; is_simulated: boolean }>(
      `SELECT h.id, h.lead_id, h.status, u.name AS designer_name, h.created_at, h.due_at, l.ref, l.caller_name, l.locality, l.scope_summary, l.is_simulated
       FROM handoffs h JOIN leads l ON l.id = h.lead_id LEFT JOIN users u ON u.id = h.designer_id
       WHERE h.status IN ('pending_assignment','assigned')${vis} ORDER BY h.status = 'pending_assignment' DESC, h.created_at`,
      p,
    ),
    db.query<{ id: string; lead_id: string; kind: string; due_at: string | null; notes: string | null; ref: string; caller_name: string | null; status: string; is_simulated: boolean }>(
      `SELECT f.id, f.lead_id, f.kind, f.due_at, f.notes, l.ref, l.caller_name, l.status, l.is_simulated FROM follow_ups f JOIN leads l ON l.id = f.lead_id
       WHERE f.status = 'open'${vis} ORDER BY f.due_at NULLS LAST`,
      p,
    ),
    can(user.role, "notifications:retry")
      ? db.query<NotificationRow & { ref: string | null }>(
          `SELECT n.*, l.ref FROM notifications n LEFT JOIN leads l ON l.id = n.lead_id WHERE n.status IN ('failed','not_configured','pending') ORDER BY n.created_at DESC LIMIT 100`,
        )
      : Promise.resolve([]),
    db.query<{ lead_id: string; status: string; preferred_text: string | null; ref: string; caller_name: string | null; is_simulated: boolean; updated_at: string }>(
      `SELECT a.lead_id, a.status, a.preferred_text, a.updated_at, l.ref, l.caller_name, l.is_simulated FROM appointments a JOIN leads l ON l.id = a.lead_id
       WHERE a.status IN ('pending_confirmation','reschedule_requested')${vis} ORDER BY a.created_at`,
      p,
    ),
  ]);
  return { handoffs, followUps, notifications, appointments };
}

export async function complaintsList(db: Db) {
  return db.query<{ id: string; lead_id: string; status: string; summary: string; client_name: string | null; designer_name: string | null; project_ref: string | null; created_at: string; acknowledged_at: string | null; resolved_at: string | null; resolution: string | null; ref: string; phone: string | null; is_simulated: boolean }>(
    `SELECT c.*, l.ref, l.phone, l.is_simulated FROM complaints c JOIN leads l ON l.id = c.lead_id ORDER BY c.status = 'resolved', c.created_at DESC`,
  );
}

export async function callsList(db: Db, user: CurrentUser, opts: { from: Date; to: Date; includeSimulated: boolean }) {
  const vis = can(user.role, "leads:view_all") ? "" : " AND l.assigned_designer_id = $3";
  const p: unknown[] = [opts.from.toISOString(), opts.to.toISOString()];
  if (vis) p.push(user.id);
  return db.query<CallRow & { ref: string; caller_name: string | null; lead_status: string; segments: string }>(
    `SELECT c.*, l.ref, l.caller_name, l.status AS lead_status, (SELECT count(*) FROM transcript_segments s WHERE s.call_id = c.id)::text AS segments
     FROM calls c JOIN leads l ON l.id = c.lead_id
     WHERE c.started_at BETWEEN $1 AND $2${opts.includeSimulated ? "" : " AND c.mode = 'live'"}${vis}
     ORDER BY c.started_at DESC LIMIT 200`,
    p,
  );
}

export async function usageList(db: Db, from: Date, to: Date, includeSimulated: boolean) {
  return db.query<{ provider: string; kind: string; quantity: string; unit: string; cost_amount: string | null; cost_currency: string | null; cost_type: "actual" | "estimate" | "unavailable"; metadata: Record<string, unknown>; created_at: string; ref: string | null }>(
    `SELECT u.*, l.ref FROM usage_events u LEFT JOIN leads l ON l.id = u.lead_id
     WHERE u.created_at BETWEEN $1 AND $2${includeSimulated ? "" : " AND (l.id IS NULL OR NOT l.is_simulated)"} ORDER BY u.created_at DESC LIMIT 500`,
    [from.toISOString(), to.toISOString()],
  );
}

export async function opsEvents(db: Db, limit = 50) {
  return db.query<{ level: string; source: string; code: string; message: string; created_at: string }>(`SELECT level, source, code, message, created_at FROM ops_events ORDER BY created_at DESC LIMIT $1`, [limit]);
}

export async function webhookEvents(db: Db, limit = 30) {
  return db.query<{ event_type: string; status: string; error: string | null; received_at: string; provider_call_id: string | null }>(
    `SELECT event_type, status, error, received_at, provider_call_id FROM webhook_events ORDER BY received_at DESC LIMIT $1`,
    [limit],
  );
}
