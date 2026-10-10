import "server-only";
import { validateTransition, type AppointmentStatus } from "@/core/appointments";
import { buildBrief } from "@/core/summary";
import { assess } from "@/core/qualification/engine";
import { fnv1a, stableStringify } from "@/core/rules";
import type { ConversationState } from "@/core/conversation/engine";
import { nextBusinessTime } from "@/core/time";
import type { Db } from "../db/client";
import { config, dashboardUrl } from "../env";
import { can, canViewLead, type Permission } from "../auth/permissions";
import type { Role } from "../auth/session-token";
import { audit } from "../repo/ops";
import type { LeadRow, LeadStatus } from "../repo/types";
import { createNotification, dispatchNotification } from "./notifications";
import { handoffEmail } from "./notification-templates";

export interface StaffUser {
  id: string;
  name: string;
  role: Role;
}

export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

function requirePermission(user: StaffUser, p: Permission) {
  if (!can(user.role, p)) throw new ForbiddenError();
}

const actor = (u: StaffUser) => ({ id: u.id, label: `${u.name} (${u.role})` });

async function loadLead(db: Db, user: StaffUser, leadId: string): Promise<LeadRow> {
  const lead = (await db.query<LeadRow>(`SELECT * FROM leads WHERE id = $1`, [leadId]))[0];
  if (!lead || !canViewLead(user, lead)) throw new ForbiddenError("Enquiry not found or not accessible.");
  return lead;
}

export type ReviewDecision = "qualify" | "decline" | "needs_more_info";

/**
 * Records a human review outcome. The original automated assessment row is preserved; a new
 * "human_override" assessment is added with the reviewer's rationale. Rules are unchanged.
 */
export async function recordReviewDecision(db: Db, user: StaffUser, leadId: string, decision: ReviewDecision, rationale: string) {
  requirePermission(user, "review:decide");
  const text = rationale.trim();
  if (text.length < 5) throw new WorkflowError("Please give a short rationale (at least 5 characters).");
  const pending: string[] = [];
  await db.tx(async (tx) => {
    const lead = await loadLead(tx, user, leadId);
    const last = (await tx.query<{ criteria: unknown; rule_version: string; facts_snapshot: unknown; review_reasons: unknown; disposition: string }>(
      `SELECT * FROM assessments WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [leadId],
    ))[0];
    if (!last) throw new WorkflowError("No automated assessment exists for this enquiry.");
    const disposition = decision === "qualify" ? "QUALIFIED" : decision === "decline" ? "DECLINED" : "INCOMPLETE";
    const status: LeadStatus = decision === "qualify" ? "qualified" : decision === "decline" ? "declined" : "incomplete";
    await tx.query(
      `INSERT INTO assessments (lead_id, kind, rule_version, disposition, criteria, review_reasons, precedence_trace, facts_snapshot, input_hash, rationale, created_by)
       VALUES ($1,'human_override',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        leadId,
        last.rule_version,
        disposition,
        JSON.stringify(last.criteria),
        JSON.stringify(last.review_reasons),
        JSON.stringify([`Human decision by ${user.name}: ${decision}`, `Automated disposition was ${last.disposition}`]),
        JSON.stringify(last.facts_snapshot),
        fnv1a(stableStringify({ leadId, decision, text, at: Date.now() })),
        text.slice(0, 2000),
        user.id,
      ],
    );
    // leads.disposition keeps the engine's automated disposition; the human decision changes the
    // workflow status and is recorded as a separate human_override assessment.
    await tx.query(`UPDATE leads SET status = $2, next_action = $3, next_action_due = $4, updated_at = now() WHERE id = $1`, [
      leadId,
      status,
      decision === "qualify" ? "Assign a designer and arrange the consultation." : decision === "needs_more_info" ? "Call the client to clarify." : null,
      decision === "decline" ? null : nextBusinessTime(new Date(), 60).toISOString(),
    ]);
    await tx.query(`UPDATE follow_ups SET status = 'done', completed_at = now(), completed_by = $2, outcome = $3 WHERE lead_id = $1 AND kind = 'review' AND status = 'open'`, [
      leadId,
      user.id,
      `Decision: ${decision}`,
    ]);
    if (decision === "needs_more_info") {
      await tx.query(
        `INSERT INTO follow_ups (lead_id, kind, status, due_at, notes, created_by) VALUES ($1,'clarification','open',$2,$3,$4)`,
        [leadId, nextBusinessTime(new Date(), 60).toISOString(), text.slice(0, 500), user.id],
      );
    }
    if (decision === "qualify") {
      const call = (await tx.query<{ id: string; conversation_state: ConversationState }>(`SELECT id, conversation_state FROM calls WHERE lead_id = $1 ORDER BY started_at DESC LIMIT 1`, [leadId]))[0];
      const facts = call?.conversation_state?.facts ?? {};
      const a = assess(facts, config().rules);
      const brief = { ...buildBrief(lead.ref, facts, a, lead.summary ?? ""), flags: [...a.reviewReasons.map((r) => r.message), `Qualified by human review: ${text}`] };
      await tx.query(`INSERT INTO handoffs (lead_id, status, brief, due_at) VALUES ($1,'pending_assignment',$2,$3) ON CONFLICT (lead_id) DO NOTHING`, [
        leadId,
        JSON.stringify(brief),
        nextBusinessTime(new Date(), 60).toISOString(),
      ]);
      const id = await createNotification(tx, {
        leadId,
        kind: "handoff",
        recipients: config().email.handoffTo,
        content: handoffEmail(brief, dashboardUrl(`/enquiries/${leadId}`), lead.is_demo || lead.is_simulated),
        idempotencyKey: `handoff:${leadId}`,
      });
      if (id) pending.push(id);
    }
    await audit(tx, actor(user), "review.decided", "lead", leadId, leadId, { status: lead.status, disposition: lead.disposition }, { status, disposition, rationale: text });
  });
  for (const id of pending) await dispatchNotification(db, id);
}

export async function assignDesigner(db: Db, user: StaffUser, leadId: string, designerId: string) {
  requirePermission(user, "handoff:assign");
  await db.tx(async (tx) => {
    const lead = await loadLead(tx, user, leadId);
    const designer = (await tx.query<{ id: string; name: string; email: string }>(`SELECT id, name, email FROM users WHERE id = $1 AND active`, [designerId]))[0];
    if (!designer) throw new WorkflowError("Designer not found.");
    const h = (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM handoffs WHERE lead_id = $1`, [leadId]))[0];
    if (!h) throw new WorkflowError("This enquiry has no designer handoff (only qualified enquiries are handed off).");
    await tx.query(`UPDATE handoffs SET designer_id = $2, status = 'assigned', assigned_at = now() WHERE id = $1`, [h.id, designerId]);
    await tx.query(`UPDATE leads SET assigned_designer_id = $2, status = 'handed_off', next_action = $3, updated_at = now() WHERE id = $1`, [
      leadId,
      designerId,
      `${designer.name} to call the client and confirm the consultation.`,
    ]);
    await tx.query(`UPDATE follow_ups SET status = 'done', completed_at = now(), completed_by = $2, outcome = 'Designer assigned' WHERE lead_id = $1 AND kind = 'handoff_assignment' AND status = 'open'`, [
      leadId,
      user.id,
    ]);
    await audit(tx, actor(user), "handoff.assigned", "handoff", h.id, leadId, { status: h.status, lead_status: lead.status }, { status: "assigned", designer: designer.name });
  });
}

export async function completeFollowUp(db: Db, user: StaffUser, followUpId: string, outcome: string) {
  requirePermission(user, "followups:manage");
  await db.tx(async (tx) => {
    const fu = (await tx.query<{ id: string; lead_id: string; status: string; kind: string }>(`SELECT * FROM follow_ups WHERE id = $1`, [followUpId]))[0];
    if (!fu) throw new WorkflowError("Follow-up not found.");
    await loadLead(tx, user, fu.lead_id);
    if (fu.status !== "open") throw new WorkflowError("This follow-up is already closed.");
    await tx.query(`UPDATE follow_ups SET status = 'done', completed_at = now(), completed_by = $2, outcome = $3 WHERE id = $1`, [followUpId, user.id, outcome.slice(0, 500) || "Done"]);
    await audit(tx, actor(user), "followup.completed", "follow_up", followUpId, fu.lead_id, { status: "open" }, { status: "done", outcome });
  });
}

export async function addFollowUp(db: Db, user: StaffUser, leadId: string, kind: string, dueAt: Date, notes: string) {
  requirePermission(user, "followups:manage");
  await db.tx(async (tx) => {
    await loadLead(tx, user, leadId);
    const r = await tx.query<{ id: string }>(`INSERT INTO follow_ups (lead_id, kind, status, due_at, notes, created_by) VALUES ($1,$2,'open',$3,$4,$5) RETURNING id`, [
      leadId,
      kind.slice(0, 40),
      dueAt.toISOString(),
      notes.slice(0, 500),
      user.id,
    ]);
    await audit(tx, actor(user), "followup.created", "follow_up", r[0].id, leadId, undefined, { kind, due: dueAt.toISOString() });
  });
}

export async function updateComplaint(db: Db, user: StaffUser, complaintId: string, status: "acknowledged" | "resolved", note: string) {
  requirePermission(user, "complaints:manage");
  await db.tx(async (tx) => {
    const c = (await tx.query<{ id: string; lead_id: string; status: string }>(`SELECT * FROM complaints WHERE id = $1`, [complaintId]))[0];
    if (!c) throw new WorkflowError("Complaint not found.");
    if (c.status === "resolved") throw new WorkflowError("Complaint is already resolved.");
    await tx.query(
      `UPDATE complaints SET status = $2, acknowledged_at = COALESCE(acknowledged_at, now()), resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE resolved_at END, resolution = COALESCE($3, resolution) WHERE id = $1`,
      [complaintId, status, note || null],
    );
    if (status === "resolved") {
      await tx.query(`UPDATE follow_ups SET status = 'done', completed_at = now(), completed_by = $2, outcome = 'Complaint resolved' WHERE lead_id = $1 AND kind = 'complaint_callback' AND status = 'open'`, [c.lead_id, user.id]);
      await tx.query(`UPDATE leads SET status = 'closed', next_action = NULL, updated_at = now() WHERE id = $1`, [c.lead_id]);
    }
    await audit(tx, actor(user), `complaint.${status}`, "complaint", complaintId, c.lead_id, { status: c.status }, { status, note });
  });
}

export async function updateAppointment(db: Db, user: StaffUser, leadId: string, to: AppointmentStatus, note: string) {
  requirePermission(user, "appointments:manage");
  await db.tx(async (tx) => {
    await loadLead(tx, user, leadId);
    const appt = (await tx.query<{ id: string; status: AppointmentStatus }>(`SELECT id, status FROM appointments WHERE lead_id = $1`, [leadId]))[0];
    if (!appt) throw new WorkflowError("No appointment request exists for this enquiry.");
    const check = validateTransition(appt.status, to, to === "confirmed" ? { by: "staff", staffUserId: user.id } : undefined);
    if (!check.ok) throw new WorkflowError(check.error);
    await tx.query(`UPDATE appointments SET status = $2, notes = $3, confirmed_by = CASE WHEN $2 = 'confirmed' THEN $4::uuid ELSE confirmed_by END, updated_at = now() WHERE id = $1`, [
      appt.id,
      to,
      note ? `${note} (by ${user.name})` : null,
      user.id,
    ]);
    await audit(tx, actor(user), "appointment.status_changed", "appointment", appt.id, leadId, { status: appt.status }, { status: to, note, confirmed_by: to === "confirmed" ? "staff (manual — no calendar integration)" : undefined });
  });
}

export async function closeLead(db: Db, user: StaffUser, leadId: string, reason: string) {
  requirePermission(user, "leads:edit");
  await db.tx(async (tx) => {
    const lead = await loadLead(tx, user, leadId);
    await tx.query(`UPDATE leads SET status = 'closed', next_action = NULL, next_action_due = NULL, updated_at = now() WHERE id = $1`, [leadId]);
    await tx.query(`UPDATE follow_ups SET status = 'cancelled', completed_at = now(), completed_by = $2, outcome = $3 WHERE lead_id = $1 AND status = 'open'`, [leadId, user.id, `Lead closed: ${reason}`]);
    await audit(tx, actor(user), "lead.closed", "lead", leadId, leadId, { status: lead.status }, { status: "closed", reason });
  });
}

export async function retryNotification(db: Db, user: StaffUser, notificationId: string) {
  requirePermission(user, "notifications:retry");
  const n = (await db.query<{ lead_id: string | null; status: string }>(`SELECT lead_id, status FROM notifications WHERE id = $1`, [notificationId]))[0];
  if (!n) throw new WorkflowError("Notification not found.");
  if (n.status === "sent" || n.status === "simulated") throw new WorkflowError("Already delivered — not resending (prevents duplicates).");
  return dispatchNotification(db, notificationId, actor(user));
}
