import "server-only";
import {
  assessState,
  disconnect,
  greeting,
  initialState,
  processTurn,
  type ConversationState,
  type EndReason,
  type EngineEvent,
} from "@/core/conversation/engine";
import { fnv1a, ruleVersion, stableStringify } from "@/core/rules";
import { buildBrief, deterministicSummary, scopeSummary, timelineSummary, authorityLabel } from "@/core/summary";
import { isWithinBusinessHours, nextBusinessTime, istParts, istDate } from "@/core/time";
import type { Assessment, Disposition, EnquiryFacts, FactKey } from "@/core/types";
import type { Db } from "../db/client";
import { config, dashboardUrl } from "../env";
import { getAiProvider, estimateAiCostUsd } from "../providers/ai";
import type { AiUsage } from "../providers/ai/types";
import { audit, opsEvent, SYSTEM_ACTOR } from "../repo/ops";
import type { CallRow, LeadRow, LeadStatus } from "../repo/types";
import { createNotification, dispatchPending } from "./notifications";
import { complaintEmail, existingClientEmail, handoffEmail, reviewEmail } from "./notification-templates";

export type CallMode = "live" | "simulated";

export interface CallKey {
  provider: string;
  providerCallId: string;
  mode: CallMode;
}

export interface TurnResult {
  reply: string;
  endCall: boolean;
  callId: string;
  leadId: string;
  leadRef: string;
  disposition: Disposition;
  stage: string;
  duplicate?: boolean;
  /** Notification ids created during this turn; dispatch them after responding. */
  pendingNotifications: string[];
}

const STATUS_FOR: Record<Disposition, LeadStatus> = {
  QUALIFIED: "qualified",
  NOT_QUALIFIED: "not_qualified",
  DECLINED: "declined",
  HUMAN_REVIEW: "review",
  INCOMPLETE: "incomplete",
  COMPLAINT_ESCALATION: "complaint",
  EXISTING_CLIENT_REQUEST: "existing_client",
};

export function normalizePhone(p?: string | null): string | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return `+91${digits.slice(-10)}`;
}

function retentionDate(from: Date): Date {
  return new Date(from.getTime() + config().transcriptRetentionDays * 86_400_000);
}

// ---------------------------------------------------------------- call start

async function lockCall(db: Db, key: CallKey): Promise<CallRow | undefined> {
  const forUpdate = db.kind === "postgres" ? " FOR UPDATE" : "";
  const rows = await db.query<CallRow>(`SELECT * FROM calls WHERE provider = $1 AND provider_call_id = $2${forUpdate}`, [key.provider, key.providerCallId]);
  return rows[0];
}

/**
 * Creates the lead + call for a new call (idempotent on provider + provider_call_id).
 * A repeat caller whose earlier enquiry is unfinished is linked to the same lead and
 * the known facts are carried over (so they are not asked again). Similar names never merge.
 */
export async function ensureCall(db: Db, key: CallKey, opts: { callerNumber?: string; at: Date }): Promise<{ call: CallRow; lead: LeadRow; created: boolean; greeting: string }> {
  return db.tx(async (tx) => {
    const existing = await lockCall(tx, key);
    if (existing) {
      const lead = (await tx.query<LeadRow>(`SELECT * FROM leads WHERE id = $1`, [existing.lead_id]))[0];
      if (opts.callerNumber && !existing.from_number) {
        await tx.query(`UPDATE calls SET from_number = $2 WHERE id = $1`, [existing.id, opts.callerNumber]);
      }
      return { call: existing, lead, created: false, greeting: greeting(existing.conversation_state as ConversationState) };
    }
    const phone = normalizePhone(opts.callerNumber);
    const simulated = key.mode === "simulated";
    const outside = !isWithinBusinessHours(opts.at);
    let lead: LeadRow | undefined;
    let duplicateOf: string | null = null;
    let carried: EnquiryFacts | undefined;
    if (phone) {
      const prior = await tx.query<LeadRow>(
        `SELECT * FROM leads WHERE phone_normalized = $1 AND is_simulated = $2 AND created_at > $3 ORDER BY created_at DESC LIMIT 1`,
        [phone, simulated, new Date(opts.at.getTime() - 30 * 86_400_000).toISOString()],
      );
      if (prior[0] && ["new", "in_call", "incomplete"].includes(prior[0].status)) {
        lead = prior[0];
        const lastCall = await tx.query<CallRow>(`SELECT * FROM calls WHERE lead_id = $1 ORDER BY started_at DESC LIMIT 1`, [lead.id]);
        carried = (lastCall[0]?.conversation_state as ConversationState | undefined)?.facts;
      } else if (prior[0]) {
        duplicateOf = prior[0].id;
      }
    }
    if (!lead) {
      lead = (
        await tx.query<LeadRow>(
          `INSERT INTO leads (channel, is_simulated, is_demo, status, phone, phone_normalized, outside_hours, first_contact_at, first_response_at, possible_duplicate_of, retention_until, created_at, updated_at)
           VALUES ('phone',$1,$2,'in_call',$3,$4,$5,$6,$6,$7,$8,$6,$6) RETURNING *`,
          [simulated, simulated || config().mode === "demo", opts.callerNumber ?? null, phone, outside, opts.at.toISOString(), duplicateOf, retentionDate(opts.at).toISOString()],
        )
      )[0];
      await audit(tx, SYSTEM_ACTOR, "lead.created", "lead", lead.id, lead.id, undefined, { ref: lead.ref, simulated, via: key.provider });
    } else {
      await tx.query(`UPDATE leads SET status = 'in_call', updated_at = now() WHERE id = $1`, [lead.id]);
      await audit(tx, SYSTEM_ACTOR, "lead.repeat_call_linked", "lead", lead.id, lead.id, undefined, { provider_call_id: key.providerCallId });
    }
    const state = initialState({ callerNumber: opts.callerNumber, recordingNotice: config().recordingEnabled });
    if (carried) {
      state.facts = { ...carried, ...state.facts };
    }
    const call = (
      await tx.query<CallRow>(
        `INSERT INTO calls (lead_id, provider, provider_call_id, mode, from_number, status, started_at, answered_at, outside_hours, conversation_state, disclosure_given)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$6,$7,$8,true) RETURNING *`,
        [lead.id, key.provider, key.providerCallId, key.mode, opts.callerNumber ?? null, opts.at.toISOString(), outside, JSON.stringify(state)],
      )
    )[0];
    const g = greeting(state);
    await tx.query(`INSERT INTO transcript_segments (call_id, seq, speaker, text) VALUES ($1, 0, 'agent', $2)`, [call.id, g]);
    return { call, lead, created: true, greeting: g };
  });
}

// ---------------------------------------------------------------- per-turn

function knownSummary(f: EnquiryFacts): string {
  return [
    f.callerName && `name ${f.callerName.value}`,
    scopeSummary(f),
    f.locality && `location ${f.locality.value.canonical ?? f.locality.value.raw}`,
    timelineSummary(f),
    f.authority && `authority ${f.authority.value}`,
  ]
    .filter(Boolean)
    .join("; ");
}

async function recordAiUsage(db: Db, usage: AiUsage, leadId: string, callId: string, purpose: string, key: string) {
  const est = estimateAiCostUsd(usage.model, usage.inputTokens, usage.outputTokens);
  await db.query(
    `INSERT INTO usage_events (lead_id, call_id, provider, kind, quantity, unit, cost_amount, cost_currency, cost_type, mode, metadata, idempotency_key)
     VALUES ($1,$2,'anthropic','llm_tokens',$3,'tokens',$4,$5,$6,$7,$8,$9) ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      leadId,
      callId,
      usage.inputTokens + usage.outputTokens,
      est ?? null,
      est !== undefined ? "USD" : null,
      est !== undefined ? "estimate" : "unavailable",
      config().mode,
      JSON.stringify({ model: usage.model, input: usage.inputTokens, output: usage.outputTokens, purpose }),
      key,
    ],
  );
}

async function persistFacts(db: Db, leadId: string, callId: string, before: EnquiryFacts, after: EnquiryFacts) {
  for (const key of Object.keys(after) as FactKey[]) {
    const a = after[key] as { value: unknown; source: string; confidence: number; validation?: string; evidence?: string } | undefined;
    const b = before[key] as typeof a;
    if (!a || (b && stableStringify(b) === stableStringify(a))) continue;
    await db.query(`UPDATE facts SET superseded = true WHERE lead_id = $1 AND key = $2 AND NOT superseded`, [leadId, key]);
    await db.query(
      `INSERT INTO facts (lead_id, call_id, key, value, source, confidence, validation, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [leadId, callId, key, JSON.stringify(a.value), a.source, a.confidence, a.validation ?? "valid", a.evidence ?? null],
    );
  }
  for (const key of Object.keys(before) as FactKey[]) {
    if (!(key in after)) await db.query(`UPDATE facts SET superseded = true WHERE lead_id = $1 AND key = $2 AND NOT superseded`, [leadId, key]);
  }
}

async function persistAssessment(db: Db, leadId: string, callId: string | null, facts: EnquiryFacts, a: Assessment) {
  const hash = fnv1a(stableStringify({ facts, v: a.ruleVersion, d: a.disposition, r: a.reviewReasons }));
  const last = await db.query<{ input_hash: string }>(
    `SELECT input_hash FROM assessments WHERE lead_id = $1 AND kind = 'automated' ORDER BY created_at DESC LIMIT 1`,
    [leadId],
  );
  if (last[0]?.input_hash === hash) return;
  const rules = config().rules;
  await db.query(`INSERT INTO rule_versions (version, config) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ruleVersion(rules), JSON.stringify(rules)]);
  await db.query(
    `INSERT INTO assessments (lead_id, call_id, kind, rule_version, disposition, criteria, review_reasons, precedence_trace, facts_snapshot, input_hash)
     VALUES ($1,$2,'automated',$3,$4,$5,$6,$7,$8,$9)`,
    [leadId, callId, a.ruleVersion, a.disposition, JSON.stringify(a.criteria), JSON.stringify(a.reviewReasons), JSON.stringify(a.precedenceTrace), JSON.stringify(facts), hash],
  );
}

async function updateLeadFromFacts(db: Db, lead: LeadRow, f: EnquiryFacts, a: Assessment, status: LeadStatus | null) {
  const enquiryType = f.intent?.value === "complaint" ? "complaint" : f.intent?.value === "existing_client" ? "existing_client" : "new_enquiry";
  await db.query(
    `UPDATE leads SET caller_name = $2, phone = COALESCE($3, phone), phone_normalized = COALESCE($4, phone_normalized), email = $5,
       project_category = $6, property_type = $7, locality = $8, area_sqft = $9, scope_summary = $10, timeline_summary = $11,
       budget_text = $12, authority = $13, enquiry_type = $14, disposition = $15, review_reasons = $16,
       status = COALESCE($17, status), updated_at = now()
     WHERE id = $1`,
    [
      lead.id,
      f.callerName?.value ?? lead.caller_name,
      f.phone?.value ?? null,
      normalizePhone(f.phone?.value),
      f.email?.value ?? lead.email,
      f.projectCategory?.value ?? null,
      f.propertyType?.value ?? null,
      f.locality ? f.locality.value.canonical ?? f.locality.value.raw : null,
      f.areaSqft?.value ?? null,
      scopeSummary(f) ?? null,
      timelineSummary(f) ?? null,
      f.budgetText?.value ?? null,
      f.authority ? authorityLabel(f) : null,
      enquiryType,
      a.disposition,
      JSON.stringify(a.reviewReasons),
      status,
    ],
  );
}

async function appendSegments(db: Db, callId: string, items: Array<{ speaker: "caller" | "agent"; text: string; confidence?: number; turnKey?: string }>) {
  const max = await db.query<{ m: number | null }>(`SELECT max(seq) AS m FROM transcript_segments WHERE call_id = $1`, [callId]);
  let seq = (max[0]?.m ?? -1) + 1;
  for (const it of items) {
    await db.query(`INSERT INTO transcript_segments (call_id, seq, speaker, text, confidence, turn_key) VALUES ($1,$2,$3,$4,$5,$6)`, [
      callId,
      seq++,
      it.speaker,
      it.text,
      it.confidence ?? null,
      it.turnKey ?? null,
    ]);
  }
}

/** Handles side effects the engine asks for during the call (escalations happen immediately). */
async function applyEvents(db: Db, lead: LeadRow, call: CallRow, state: ConversationState, events: EngineEvent[], pending: string[]) {
  const f = state.facts;
  for (const e of events) {
    if (e.type === "complaint_detected") {
      const c = await db.query<{ id: string }>(
        `INSERT INTO complaints (lead_id, call_id, client_name, designer_name, project_ref, summary) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (lead_id) DO NOTHING RETURNING id`,
        [lead.id, call.id, f.callerName?.value ?? null, f.existingDesigner?.value ?? null, f.locality?.value.canonical ?? f.locality?.value.raw ?? null, f.complaintSummary?.value ?? "Complaint raised on call"],
      );
      if (c[0]) await audit(db, SYSTEM_ACTOR, "complaint.escalated", "complaint", c[0].id, lead.id, undefined, { via: "call" });
      await upsertFollowUp(db, lead.id, "complaint_callback", "Senior team to call the client back about their complaint.", urgentDue(new Date()));
    }
    if (e.type === "human_callback_requested") {
      await upsertFollowUp(db, lead.id, "callback_requested", "Caller asked to speak with a person.", nextBusinessTime(new Date(), 30));
    }
    if (e.type === "pricing_guard_blocked") {
      await opsEvent(db, "warn", "pricing_guard", "OUTBOUND_BLOCKED", `Blocked an outbound line (${e.violations.join(",")}); approved pricing response used.`, lead.id);
    }
    if (e.type === "prompt_injection_attempt") {
      await opsEvent(db, "info", "conversation", "PROMPT_INJECTION_ATTEMPT", "Caller attempted to override instructions or obtain internal material.", lead.id);
    }
  }
  void pending;
}

function urgentDue(now: Date): Date {
  return isWithinBusinessHours(now) ? new Date(now.getTime() + 15 * 60_000) : nextBusinessTime(now, 0);
}

async function upsertFollowUp(db: Db, leadId: string, kind: string, notes: string, due: Date) {
  await db.query(
    `INSERT INTO follow_ups (lead_id, kind, status, due_at, notes, dedupe_key) VALUES ($1,$2,'open',$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING`,
    [leadId, kind, due.toISOString(), notes, `${leadId}:${kind}`],
  );
}

export interface TurnInputArgs extends CallKey {
  text: string;
  confidence?: number;
  turnKey?: string;
  callerNumber?: string;
  at?: Date;
}

export async function handleCallerTurn(db: Db, args: TurnInputArgs): Promise<TurnResult> {
  const at = args.at ?? new Date();
  const { call: startCall, lead: startLead } = await ensureCall(db, args, { callerNumber: args.callerNumber, at });
  const rules = config().rules;

  // Idempotency: a repeated provider turn returns the reply already given.
  if (args.turnKey) {
    const dup = await db.query<{ text: string }>(
      `SELECT text FROM transcript_segments WHERE call_id = $1 AND turn_key = $2`,
      [startCall.id, `${args.turnKey}:agent`],
    );
    if (dup[0]) {
      const st = startCall.conversation_state as ConversationState;
      return {
        reply: dup[0].text,
        endCall: !!st.ended,
        callId: startCall.id,
        leadId: startLead.id,
        leadRef: startLead.ref,
        disposition: st.lastDisposition ?? "INCOMPLETE",
        stage: st.stage,
        duplicate: true,
        pendingNotifications: [],
      };
    }
  }

  // Optional LLM extraction runs outside the transaction (network call, bounded by a timeout).
  let extraFacts: Partial<EnquiryFacts> | undefined;
  const ai = getAiProvider();
  const priorState = startCall.conversation_state as ConversationState;
  if (ai.live && config().anthropic.turnExtraction && args.text.trim()) {
    try {
      const r = await ai.extractFacts({ utterance: args.text, lastQuestion: priorState.lastQuestion, knownSummary: knownSummary(priorState.facts), now: at });
      extraFacts = r.facts;
      if (r.usage) await recordAiUsage(db, r.usage, startLead.id, startCall.id, "turn_extraction", `ai:${startCall.id}:${args.turnKey ?? priorState.turn + 1}`);
    } catch (err) {
      await opsEvent(db, "warn", "ai", "EXTRACTION_FALLBACK", `LLM extraction unavailable (${(err as Error).name}); rule-based extraction used.`, startLead.id);
    }
  }

  const pending: string[] = [];
  const result = await db.tx(async (tx) => {
    const call = (await lockCall(tx, args))!;
    const lead = (await tx.query<LeadRow>(`SELECT * FROM leads WHERE id = $1`, [call.lead_id]))[0];
    const state = call.conversation_state as ConversationState;
    if (args.turnKey) {
      const dup = await tx.query<{ text: string }>(`SELECT text FROM transcript_segments WHERE call_id = $1 AND turn_key = $2`, [call.id, `${args.turnKey}:agent`]);
      if (dup[0]) return { reply: dup[0].text, endCall: !!state.ended, call, lead, state, assessment: assessState(state, rules), duplicate: true };
    }
    const out = processTurn(state, { text: args.text, confidence: args.confidence, now: at }, { rules, extraFacts });
    await appendSegments(tx, call.id, [
      { speaker: "caller", text: args.text || "(silence)", confidence: args.confidence, turnKey: args.turnKey ? `${args.turnKey}:caller` : undefined },
      { speaker: "agent", text: out.reply, turnKey: args.turnKey ? `${args.turnKey}:agent` : undefined },
    ]);
    await tx.query(`UPDATE calls SET conversation_state = $2 WHERE id = $1`, [call.id, JSON.stringify(out.state)]);
    await persistFacts(tx, lead.id, call.id, state.facts, out.state.facts);
    await persistAssessment(tx, lead.id, call.id, out.state.facts, out.assessment);
    await updateLeadFromFacts(tx, lead, out.state.facts, out.assessment, null);
    await applyEvents(tx, lead, call, out.state, out.events, pending);
    if (out.endCall) {
      await tx.query(`UPDATE calls SET status = 'completed', ended_at = $2, end_reason = $3,
                        duration_sec = EXTRACT(EPOCH FROM ($2::timestamptz - started_at)) WHERE id = $1 AND ended_at IS NULL`, [
        call.id,
        at.toISOString(),
        out.state.endReason ?? "completed",
      ]);
      pending.push(...(await finalizeInTx(tx, call.id)));
    }
    return { reply: out.reply, endCall: out.endCall, call, lead, state: out.state, assessment: out.assessment, duplicate: false };
  });

  return {
    reply: result.reply,
    endCall: result.endCall,
    callId: result.call.id,
    leadId: result.lead.id,
    leadRef: result.lead.ref,
    disposition: result.assessment.disposition,
    stage: result.state.stage,
    duplicate: result.duplicate,
    pendingNotifications: pending,
  };
}

// ---------------------------------------------------------------- end of call

/** Line dropped / caller hung up / provider reported call end. Idempotent. */
export async function endCall(
  db: Db,
  key: CallKey,
  opts: { reason?: EndReason | string; durationSec?: number; at?: Date },
): Promise<{ found: boolean; pendingNotifications: string[]; callId?: string }> {
  const at = opts.at ?? new Date();
  const rules = config().rules;
  return db.tx(async (tx) => {
    const call = await lockCall(tx, key);
    if (!call) return { found: false, pendingNotifications: [] };
    const state = call.conversation_state as ConversationState;
    if (!state.ended) {
      const out = disconnect(state, rules, "disconnected");
      await tx.query(`UPDATE calls SET conversation_state = $2 WHERE id = $1`, [call.id, JSON.stringify(out.state)]);
      await persistAssessment(tx, call.lead_id, call.id, out.state.facts, out.assessment);
      await tx.query(`INSERT INTO transcript_segments (call_id, seq, speaker, text) SELECT $1, COALESCE(max(seq),-1)+1, 'system', $2 FROM transcript_segments WHERE call_id = $1`, [
        call.id,
        `Call ended (${opts.reason ?? "disconnected"}) before the conversation finished.`,
      ]);
    }
    // Hanging up after the assistant's closing line is a normal end, not a dropped call.
    const status = state.ended || state.closingSent ? "completed" : "disconnected";
    await tx.query(
      `UPDATE calls SET status = CASE WHEN status = 'active' THEN $2 ELSE status END,
         ended_at = COALESCE(ended_at, $3), end_reason = COALESCE(end_reason, $4),
         duration_sec = COALESCE($5, duration_sec, EXTRACT(EPOCH FROM ($3::timestamptz - started_at)))
       WHERE id = $1`,
      [call.id, status, at.toISOString(), opts.reason ?? "disconnected", opts.durationSec ?? null],
    );
    const pending = await finalizeInTx(tx, call.id);
    return { found: true, pendingNotifications: pending, callId: call.id };
  });
}

/**
 * Post-call workflow (runs once per call, inside a transaction). Creates every business record
 * BEFORE any notification is attempted: handoff, review entry, escalation, follow-ups,
 * appointment request. Returns notification ids to dispatch after commit.
 */
export async function finalizeInTx(tx: Db, callId: string): Promise<string[]> {
  const claimed = await tx.query<CallRow>(`UPDATE calls SET finalized_at = now() WHERE id = $1 AND finalized_at IS NULL RETURNING *`, [callId]);
  const call = claimed[0];
  if (!call) return [];
  const lead = (await tx.query<LeadRow>(`SELECT * FROM leads WHERE id = $1`, [call.lead_id]))[0];
  const cfg = config();
  const state = call.conversation_state as ConversationState;
  const a = assessState(state, cfg.rules);
  const f = state.facts;
  const summary = deterministicSummary(f, a);
  const demo = lead.is_demo || lead.is_simulated;
  const link = dashboardUrl(`/enquiries/${lead.id}`);
  const now = new Date();
  const pending: string[] = [];

  await tx.query(`UPDATE calls SET summary = $2, summary_source = 'deterministic' WHERE id = $1`, [call.id, summary]);
  await updateLeadFromFacts(tx, lead, f, a, STATUS_FOR[a.disposition]);
  await tx.query(`UPDATE leads SET summary = $2 WHERE id = $1`, [lead.id, summary]);
  await audit(tx, SYSTEM_ACTOR, "lead.assessed", "lead", lead.id, lead.id, { status: lead.status }, { status: STATUS_FOR[a.disposition], disposition: a.disposition, rule_version: a.ruleVersion });

  let nextAction: string | null = null;
  let due: Date | null = null;

  switch (a.disposition) {
    case "QUALIFIED": {
      const brief = buildBrief(lead.ref, f, a, summary);
      const h = await tx.query<{ id: string }>(
        `INSERT INTO handoffs (lead_id, status, brief, due_at) VALUES ($1,'pending_assignment',$2,$3) ON CONFLICT (lead_id) DO NOTHING RETURNING id`,
        [lead.id, JSON.stringify(brief), nextBusinessTime(now, 60).toISOString()],
      );
      if (h[0]) await audit(tx, SYSTEM_ACTOR, "handoff.created", "handoff", h[0].id, lead.id, undefined, { status: "pending_assignment" });
      if (f.consultationRequested?.value || f.consultationPreference) {
        await tx.query(
          `INSERT INTO appointments (lead_id, preferred_text, status, provider, notes) VALUES ($1,$2,'pending_confirmation','manual',$3) ON CONFLICT (lead_id) DO NOTHING`,
          [lead.id, f.consultationPreference?.value ?? null, "Requested on call. No calendar integration — must be confirmed with the client by a team member."],
        );
      }
      const id = await createNotification(tx, {
        leadId: lead.id,
        kind: "handoff",
        recipients: cfg.email.handoffTo,
        content: handoffEmail(brief, link, demo),
        idempotencyKey: `handoff:${lead.id}`,
      });
      if (id) pending.push(id);
      nextAction = "Assign a designer and call the client to arrange the consultation.";
      due = nextBusinessTime(now, 60);
      await upsertFollowUp(tx, lead.id, "handoff_assignment", "Assign a designer to this qualified lead.", due);
      break;
    }
    case "HUMAN_REVIEW": {
      const id = await createNotification(tx, {
        leadId: lead.id,
        kind: "review",
        recipients: cfg.email.reviewTo,
        content: reviewEmail(lead.ref, f.callerName?.value, f.locality?.value.canonical ?? f.locality?.value.raw, a.reviewReasons.map((r) => r.message), link, demo),
        idempotencyKey: `review:${lead.id}:${a.ruleVersion}`,
      });
      if (id) pending.push(id);
      nextAction = "Review the case and record a decision.";
      due = nextBusinessTime(now, 120);
      await upsertFollowUp(tx, lead.id, "review", "Human review required.", due);
      break;
    }
    case "INCOMPLETE": {
      nextAction = `Call back to complete: ${a.missingCritical.join(", ").toLowerCase() || "details"}.`;
      due = nextBusinessTime(now, 60);
      await upsertFollowUp(tx, lead.id, "callback_incomplete", `Call ended before ${a.missingCritical.join(", ").toLowerCase() || "the enquiry was complete"} was established.`, due);
      break;
    }
    case "COMPLAINT_ESCALATION": {
      await tx.query(
        `INSERT INTO complaints (lead_id, call_id, client_name, designer_name, project_ref, summary) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (lead_id) DO UPDATE SET client_name = COALESCE(EXCLUDED.client_name, complaints.client_name),
           designer_name = COALESCE(EXCLUDED.designer_name, complaints.designer_name),
           project_ref = COALESCE(EXCLUDED.project_ref, complaints.project_ref), summary = EXCLUDED.summary`,
        [lead.id, call.id, f.callerName?.value ?? null, f.existingDesigner?.value ?? null, f.locality?.value.canonical ?? f.locality?.value.raw ?? null, f.complaintSummary?.value ?? summary],
      );
      const id = await createNotification(tx, {
        leadId: lead.id,
        kind: "complaint",
        recipients: cfg.email.complaintsTo,
        content: complaintEmail(
          lead.ref,
          { name: f.callerName?.value, phone: f.phone?.value, designer: f.existingDesigner?.value, project: f.locality?.value.canonical ?? f.locality?.value.raw, summary: f.complaintSummary?.value ?? summary },
          link,
          demo,
        ),
        idempotencyKey: `complaint:${lead.id}`,
      });
      if (id) pending.push(id);
      nextAction = "Senior team member to call the client back.";
      due = urgentDue(now);
      await upsertFollowUp(tx, lead.id, "complaint_callback", "Senior team to call the client back about their complaint.", due);
      break;
    }
    case "EXISTING_CLIENT_REQUEST": {
      const id = await createNotification(tx, {
        leadId: lead.id,
        kind: "existing_client",
        recipients: cfg.email.complaintsTo,
        content: existingClientEmail(lead.ref, { name: f.callerName?.value, phone: f.phone?.value, designer: f.existingDesigner?.value, message: f.complaintSummary?.value ?? summary }, link, demo),
        idempotencyKey: `existing:${lead.id}:${call.id}`,
      });
      if (id) pending.push(id);
      nextAction = "Pass the message to the client's project team.";
      due = nextBusinessTime(now, 60);
      await upsertFollowUp(tx, lead.id, "existing_client_message", "Relay the existing client's message to their project team.", due);
      break;
    }
    case "DECLINED":
    case "NOT_QUALIFIED":
      nextAction = null;
      break;
  }
  await tx.query(`UPDATE leads SET next_action = $2, next_action_due = $3 WHERE id = $1`, [lead.id, nextAction, due?.toISOString() ?? null]);
  return pending;
}

/** After-response work: send notifications, then try an LLM summary (never blocks the record). */
export async function afterCallWork(db: Db, callId: string | undefined, notificationIds: string[]) {
  await dispatchPending(db, notificationIds);
  if (!callId) return;
  const ai = getAiProvider();
  if (!ai.live) return;
  try {
    const call = (await db.query<CallRow>(`SELECT * FROM calls WHERE id = $1`, [callId]))[0];
    if (!call?.finalized_at || call.summary_source === "ai") return;
    const segs = await db.query<{ speaker: "caller" | "agent" | "system"; text: string }>(`SELECT speaker, text FROM transcript_segments WHERE call_id = $1 ORDER BY seq`, [callId]);
    const r = await ai.summarize({ transcript: segs, structuredRecap: call.summary ?? "" });
    await db.query(`UPDATE calls SET summary = $2, summary_source = 'ai' WHERE id = $1`, [callId, r.summary.slice(0, 2000)]);
    if (r.usage) await recordAiUsage(db, r.usage, call.lead_id, callId, "summary", `ai-summary:${callId}`);
  } catch (err) {
    await opsEvent(db, "warn", "ai", "SUMMARY_FALLBACK", `LLM summary unavailable (${(err as Error).name}); deterministic summary kept.`, null, { callId });
  }
}

/** Seconds into the IST day — used by the seeder to place synthetic calls at realistic times. */
export function istAt(base: Date, daysAgo: number, hour: number, minute: number): Date {
  const p = istParts(base);
  return istDate(p.year, p.month, p.day - daysAgo, hour, minute);
}
