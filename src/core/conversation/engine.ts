// Stateful receptionist conversation engine.
//
// Pure function of (state, caller input, rules, optional extra extraction) → (new state, reply,
// events). It never decides eligibility itself — that is the qualification engine's job — and it
// never claims a qualification, a confirmed booking or a human notification. All replies pass the
// pricing guard.

import { extractFromUtterance, type QuestionKey, type Signals } from "../extraction/rules-extractor";
import { mergeFacts, type FactConflict } from "../extraction/merge";
import { assess } from "../qualification/engine";
import { APPROVED_PRICING_RESPONSE, guardOutbound } from "../pricing/policy";
import { findLocations, lookupLocality } from "../locations";
import type { RuleConfig } from "../rules";
import type { Assessment, Disposition, EnquiryFacts, ReviewReason } from "../types";
import {
  DECLINE_TWO_OR_MORE,
  GREETING,
  LINES,
  QUESTIONS,
  REASK,
  RECORDING_NOTICE,
  acknowledgement,
  complaintClosing,
  incompleteClosing,
  qualifiedClosing,
  reviewClosing,
  singleFailureClose,
} from "./templates";

export type Stage =
  | "greeting"
  | "intent_identification"
  | "new_enquiry"
  | "scope_clarification"
  | "location_clarification"
  | "timeline_clarification"
  | "authority_clarification"
  | "budget_context"
  | "contact_details"
  | "qualification_pending"
  | "consultation_booking"
  | "existing_client_identification"
  | "complaint_escalation"
  | "qualified"
  | "declined"
  | "human_review"
  | "handoff_pending"
  | "completed"
  | "disconnected";

export type EndReason = "completed" | "caller_ended" | "disconnected" | "silence_timeout";

export type EngineEvent =
  | { type: "complaint_detected" }
  | { type: "existing_client_request" }
  | { type: "consultation_requested"; preference?: string }
  | { type: "human_callback_requested" }
  | { type: "pricing_question"; count: number }
  | { type: "pricing_guard_blocked"; violations: string[] }
  | { type: "prompt_injection_attempt" }
  | { type: "conflict_detected"; key: string }
  | { type: "call_ended"; reason: EndReason; disposition: Disposition };

export interface ConversationState {
  version: 1;
  stage: Stage;
  facts: EnquiryFacts;
  asked: Partial<Record<QuestionKey, number>>;
  lastQuestion: QuestionKey | null;
  turn: number;
  pricingQuestions: number;
  silenceCount: number;
  conflicts: FactConflict[];
  /** Fact keys awaiting caller confirmation because they were heard with low confidence. */
  pendingConfirm?: { key: keyof EnquiryFacts; display: string };
  humanCallbackRequested: boolean;
  closingSent: boolean;
  ended: boolean;
  endReason?: EndReason;
  lastDisposition?: Disposition;
  recordingNotice: boolean;
}

export interface TurnInput {
  text: string;
  /** Speech-to-text confidence 0..1, when the provider supplies it. */
  confidence?: number;
  now: Date;
}

export interface TurnOutput {
  state: ConversationState;
  reply: string;
  endCall: boolean;
  events: EngineEvent[];
  assessment: Assessment;
}

export interface EngineDeps {
  rules: RuleConfig;
  /** Optional additional facts (e.g. from the LLM extractor), already schema-validated. */
  extraFacts?: Partial<EnquiryFacts>;
}

export function initialState(opts: { callerNumber?: string; recordingNotice?: boolean } = {}): ConversationState {
  const facts: EnquiryFacts = {};
  if (opts.callerNumber) {
    facts.phone = { value: opts.callerNumber, source: "system", confidence: 0.99, evidence: "caller ID", validation: "valid" };
  }
  return {
    version: 1,
    stage: "greeting",
    facts,
    asked: {},
    lastQuestion: null,
    turn: 0,
    pricingQuestions: 0,
    silenceCount: 0,
    conflicts: [],
    humanCallbackRequested: false,
    closingSent: false,
    ended: false,
    recordingNotice: !!opts.recordingNotice,
  };
}

export function greeting(state: ConversationState): string {
  return GREETING + (state.recordingNotice ? RECORDING_NOTICE : "");
}

/** Extra review reasons that come from conversation state rather than individual facts. */
export function stateReviewReasons(state: ConversationState): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  const open = state.conflicts.filter((c) => !c.resolved);
  for (const c of open) {
    reasons.push({
      code: "CONFLICT.UNRESOLVED",
      message: `Conflicting answers for ${String(c.key)}: "${display(c.previous.value)}" vs "${display(c.incoming.value)}".`,
      mandatory: true,
    });
  }
  return reasons;
}

export function assessState(state: ConversationState, rules: RuleConfig): Assessment {
  return assess(state.facts, rules, stateReviewReasons(state));
}

function display(v: unknown): string {
  if (v && typeof v === "object" && "raw" in (v as object)) {
    const l = v as { raw: string; canonical?: string };
    return l.canonical ?? l.raw;
  }
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function firstName(state: ConversationState): string | undefined {
  return state.facts.callerName?.value.split(" ")[0];
}

const DECISIVE_KEYS: Array<keyof EnquiryFacts> = ["locality", "engagement", "structuralWork", "completionWeeks", "propertyType"];

/** Chooses the next single question, or null when nothing more is needed. */
function nextQuestion(state: ConversationState, a: Assessment): QuestionKey | null {
  const f = state.facts;
  const asked = (q: QuestionKey) => state.asked[q] ?? 0;
  const can = (q: QuestionKey, max = 2) => asked(q) < max;
  const crit = Object.fromEntries(a.criteria.map((c) => [c.id, c]));

  if (!f.intent && !f.projectCategory && !f.scopeSize && !f.engagement && can("intent", 1)) return "intent";

  // Scope
  if (crit.SCOPE.state === "UNKNOWN") {
    if (!f.scopeSize && can("scope")) return "scope";
    if (!f.engagement && can("engagement", 1)) return "engagement";
    if (f.ownership?.value === "rented" && !f.structuralWork && can("structural", 1)) return "structural";
  }
  // Location
  if (crit.LOCATION.state === "UNKNOWN" || (crit.LOCATION.state === "REVIEW" && crit.LOCATION.ruleCode === "LOCATION.UNRECOGNISED" && !f.localityClaimedInArea)) {
    if (f.locality?.value.alternatives?.length && can("location_choice", 1)) return "location_choice";
    if (f.locality && !f.locality.value.canonical && !lookupLocality(f.locality.value.raw) && !findLocations(f.locality.value.raw).length && can("location_in_area", 1)) {
      return "location_in_area";
    }
    if (can("location")) return "location";
  }
  // Commercial area
  if (crit.COMMERCIAL_SIZE.applicable && crit.COMMERCIAL_SIZE.state === "UNKNOWN" && can("area", 1)) return "area";
  // Timeline
  if (crit.TIMELINE.state === "UNKNOWN") {
    if (f.completionAsap && can("timeline_specific", 1)) return "timeline_specific";
    if (can("timeline")) return "timeline";
  }
  // Site readiness: only when there are signs the site isn't available yet.
  const possessionPending = /possession|handover|under construction|new (flat|property|construction)|getting the keys/i.test(
    `${f.timelineText?.evidence ?? ""} ${f.timelineText?.value ?? ""}`,
  );
  if (!f.siteReadyWeeks && possessionPending && can("site_ready", 1)) return "site_ready";
  // Authority (asked once; never pushed)
  if (!f.authority && can("authority", 1)) return "authority";
  if (f.authority?.value === "researching_for_others" && can("authority_followup", 1)) return "authority_followup";
  // Contact details
  if (!f.callerName && can("name")) return "name";
  if (!f.phone && can("phone", 1)) return "phone";
  return null;
}

function ask(state: ConversationState, q: QuestionKey): string {
  const times = state.asked[q] ?? 0;
  state.asked[q] = times + 1;
  state.lastQuestion = q;
  if (times > 0 && REASK[q]) return REASK[q]!;
  return QUESTIONS[q];
}

function stageFor(q: QuestionKey | null, disposition: Disposition): Stage {
  if (disposition === "COMPLAINT_ESCALATION") return "complaint_escalation";
  if (disposition === "EXISTING_CLIENT_REQUEST") return "existing_client_identification";
  switch (q) {
    case "intent":
      return "intent_identification";
    case "scope":
    case "engagement":
    case "structural":
    case "area":
      return "scope_clarification";
    case "location":
    case "location_in_area":
    case "location_choice":
      return "location_clarification";
    case "timeline":
    case "timeline_specific":
    case "site_ready":
      return "timeline_clarification";
    case "authority":
    case "authority_followup":
      return "authority_clarification";
    case "name":
    case "phone":
      return "contact_details";
    case "consultation_offer":
    case "consultation_time":
      return "consultation_booking";
    default:
      return "new_enquiry";
  }
}

/** Short acknowledgement of the most useful newly learned fact (at most one). */
function ackFor(changed: string[], facts: EnquiryFacts): string {
  if (changed.includes("scopeSize") && facts.scopeSize && facts.engagement?.value === "design_and_execution") {
    return acknowledgement(facts.scopeSize.value === "partial" ? "multi_room" : facts.scopeSize.value);
  }
  if (changed.includes("locality") && facts.locality?.value.canonical) {
    const entry = lookupLocality(facts.locality.value.canonical);
    if (entry && (entry.zone === "documented" || entry.zone === "known_city")) return acknowledgement("locality", entry.canonical);
  }
  return "";
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function finish(
  state: ConversationState,
  rules: RuleConfig,
  reply: string,
  endCall: boolean,
  events: EngineEvent[],
): TurnOutput {
  const guarded = guardOutbound(reply);
  if (guarded.blocked) events.push({ type: "pricing_guard_blocked", violations: guarded.violations });
  const assessment = assessState(state, rules);
  state.lastDisposition = assessment.disposition;
  if (endCall && !state.ended) {
    state.ended = true;
    state.endReason = state.endReason ?? "completed";
    if (state.stage !== "disconnected") state.stage = state.stage === "completed" ? "completed" : state.stage;
    events.push({ type: "call_ended", reason: state.endReason, disposition: assessment.disposition });
  }
  return { state, reply: guarded.text, endCall, events, assessment };
}

/** Marks the call as ended by the caller hanging up / line dropping. Preserves all facts. */
export function disconnect(prev: ConversationState, rules: RuleConfig, reason: EndReason = "disconnected"): TurnOutput {
  const state: ConversationState = structuredClone(prev);
  const events: EngineEvent[] = [];
  const assessment = assessState(state, rules);
  state.lastDisposition = assessment.disposition;
  if (!state.ended) {
    state.ended = true;
    state.endReason = reason;
    if (!state.closingSent) state.stage = "disconnected";
    events.push({ type: "call_ended", reason, disposition: assessment.disposition });
  }
  return { state, reply: "", endCall: true, events, assessment };
}

function handleConfirmation(state: ConversationState, signals: Signals): string | null {
  const pending = state.pendingConfirm;
  if (!pending || state.lastQuestion !== "confirm_value") return null;
  const f = state.facts[pending.key] as { confidence: number; validation?: string; source: string } | undefined;
  state.pendingConfirm = undefined;
  if (f && signals.affirmative && !signals.negative) {
    f.confidence = 0.9;
    f.validation = "valid";
    f.source = "caller_stated";
    for (const c of state.conflicts) if (c.key === pending.key) c.resolved = true;
    return "Thank you.";
  }
  if (f && signals.negative) {
    delete state.facts[pending.key];
    for (const c of state.conflicts) if (c.key === pending.key) c.resolved = true;
    return "Sorry about that.";
  }
  return null;
}

export function processTurn(prev: ConversationState, input: TurnInput, deps: EngineDeps): TurnOutput {
  const state: ConversationState = structuredClone(prev);
  const { rules } = deps;
  const events: EngineEvent[] = [];

  if (state.ended) {
    return finish(state, rules, LINES.closingGeneric, true, events);
  }
  state.turn += 1;
  if (state.stage === "greeting") state.stage = "intent_identification";

  const text = input.text ?? "";
  const extraction = extractFromUtterance(text, {
    lastQuestion: state.lastQuestion,
    now: input.now,
    turn: state.turn,
    sttConfidence: input.confidence,
  });
  const { signals } = extraction;

  // --- Silence / unclear audio ---
  if (signals.empty) {
    state.silenceCount += 1;
    if (state.silenceCount >= 3) {
      state.endReason = "silence_timeout";
      state.stage = "disconnected";
      return finish(state, rules, LINES.silenceEnd, true, events);
    }
    return finish(state, rules, LINES.silence, false, events);
  }
  state.silenceCount = 0;

  // --- Confirmation of a low-confidence or conflicting value ---
  const confirmAck = handleConfirmation(state, signals);

  // --- Merge facts (rules first, then validated LLM facts as lower-trust input) ---
  const merged = mergeFacts(state.facts, extraction.facts, { correction: signals.correction, lastQuestion: state.lastQuestion });
  let facts = merged.facts;
  const conflicts = [...merged.conflicts];
  let changed = [...merged.changed];
  if (deps.extraFacts && Object.keys(deps.extraFacts).length) {
    const ai = mergeFacts(facts, deps.extraFacts, { correction: false, lastQuestion: state.lastQuestion });
    facts = ai.facts;
    conflicts.push(...ai.conflicts);
    changed = [...new Set([...changed, ...ai.changed])];
  }
  state.facts = facts;
  // A correction or a direct answer resolves earlier conflicts on the same fact.
  for (const c of state.conflicts) if (!c.resolved && changed.includes(c.key) && !conflicts.find((n) => n.key === c.key)) c.resolved = true;
  for (const c of conflicts) {
    state.conflicts.push(c);
    events.push({ type: "conflict_detected", key: String(c.key) });
  }

  // --- Prompt injection / internal documents ---
  if (signals.promptInjection) {
    events.push({ type: "prompt_injection_attempt" });
    const assessment = assessState(state, rules);
    const q = state.closingSent ? null : nextQuestion(state, assessment);
    const line = /pricing|price|rate/i.test(text) ? LINES.internalDocs : LINES.injection;
    return finish(state, rules, join(line, q ? ask(state, q) : QUESTIONS.anything_else), false, events);
  }

  // --- Complaint / existing client: separate workflow ---
  const intent = state.facts.intent?.value;
  if (intent === "complaint" || intent === "existing_client") {
    return complaintFlow(state, rules, events, signals, intent);
  }

  // --- Pricing: fixed approved response, qualification continues afterwards ---
  if (signals.pricingQuestion) {
    state.pricingQuestions += 1;
    events.push({ type: "pricing_question", count: state.pricingQuestions });
    // The approved line ends with a booking offer, so a "yes" next turn is captured as a booking.
    state.lastQuestion = "consultation_offer";
    const reply = state.pricingQuestions > 1 ? LINES.pricingRepeatPrefix + APPROVED_PRICING_RESPONSE : APPROVED_PRICING_RESPONSE;
    return finish(state, rules, reply, false, events);
  }

  // --- Human request (no verified transfer capability → callback task) ---
  let prefix = confirmAck ?? "";
  if (signals.humanRequest && !state.humanCallbackRequested) {
    state.humanCallbackRequested = true;
    events.push({ type: "human_callback_requested" });
    prefix = join(prefix, LINES.humanCallback, LINES.humanCallbackContinue);
  }

  // --- Booking intent ---
  if (state.facts.consultationRequested?.value && !prev.facts.consultationRequested?.value) {
    events.push({ type: "consultation_requested", preference: state.facts.consultationPreference?.value });
    if (!prefix) prefix = LINES.bookingAck;
  }

  // --- Budget volunteered: acknowledge neutrally, never quote ---
  if (changed.includes("budgetInr") && !prev.facts.budgetInr) {
    prefix = join(prefix, LINES.budgetNoted);
  }

  // --- Caller is wrapping up ---
  const assessment = assessState(state, rules);
  // After a closing line, a short acknowledgement ("Okay, thanks", "Understood") ends the call.
  const politeRemainder = text
    .toLowerCase()
    .replace(/\b(ok(ay)?|alright|all right|fine|understood|i understand|got it|i see|oh|ah|sure|no problem|that'?s fine|right|cool|thanks|thank you|so much|a lot|very much|anyway|no worries|fair enough|makes sense)\b/g, "")
    .replace(/[^a-z]+/g, "");
  const acknowledgementOnly = state.closingSent && /\w/.test(text) && politeRemainder === "";
  if (signals.goodbye || acknowledgementOnly || (state.closingSent && (signals.negative || state.lastQuestion === "anything_else"))) {
    if (signals.goodbye || signals.negative || acknowledgementOnly) {
      state.endReason = "caller_ended";
      const closing =
        assessment.disposition === "INCOMPLETE" && !state.closingSent ? incompleteClosing(firstName(state)) : LINES.closingGeneric;
      if (state.stage !== "declined" && state.stage !== "qualified" && state.stage !== "human_review") state.stage = "completed";
      return finish(state, rules, closing, true, events);
    }
  }

  // --- Low-confidence decisive fact: confirm before acting on it ---
  if (input.confidence !== undefined && input.confidence < rules.minDecisiveConfidence) {
    const key = DECISIVE_KEYS.find((k) => changed.includes(k));
    if (key) {
      state.pendingConfirm = { key, display: display((state.facts[key] as { value: unknown }).value) };
      state.lastQuestion = "confirm_value";
      return finish(state, rules, `Sorry, the line isn't very clear — did you say ${state.pendingConfirm.display}?`, false, events);
    }
  }
  // --- Unprompted conflicting answer: confirm ---
  const openConflict = conflicts.find((c) => !c.resolved && DECISIVE_KEYS.includes(c.key));
  if (openConflict) {
    state.pendingConfirm = { key: openConflict.key, display: display(state.facts[openConflict.key] ? (state.facts[openConflict.key] as { value: unknown }).value : openConflict.incoming.value) };
    state.lastQuestion = "confirm_value";
    return finish(
      state,
      rules,
      `Just to make sure I have this right — earlier I noted ${display(openConflict.previous.value)}, and now ${display(openConflict.incoming.value)}. Is it ${state.pendingConfirm.display}?`,
      false,
      events,
    );
  }

  const ack = ackFor(changed, state.facts);
  const d = assessment.disposition;

  // --- Decline / close on confirmed failures ---
  if ((d === "DECLINED" || d === "NOT_QUALIFIED") && !state.closingSent) {
    state.closingSent = true;
    state.stage = "declined";
    state.lastQuestion = "anything_else";
    const failed = assessment.criteria.find((c) => c.state === "FAIL")!;
    const line = d === "DECLINED" ? join("Thank you for explaining.", DECLINE_TWO_OR_MORE, QUESTIONS.anything_else) : singleFailureClose(failed.id, failed.ruleCode);
    return finish(state, rules, join(prefix, line), false, events);
  }

  // After a closing line, keep answering politely without re-opening qualification.
  if (state.closingSent) {
    if (state.facts.consultationRequested?.value && !state.facts.consultationPreference && state.stage === "qualified" && (state.asked.consultation_time ?? 0) < 2) {
      return finish(state, rules, join(prefix, ask(state, "consultation_time")), false, events);
    }
    if (state.stage === "qualified" && changed.includes("consultationPreference")) {
      events.push({ type: "consultation_requested", preference: state.facts.consultationPreference?.value });
      return finish(state, rules, join(prefix, qualifiedClosing(firstName(state), state.facts.consultationPreference?.value)), false, events);
    }
    state.lastQuestion = "anything_else";
    return finish(state, rules, join(prefix, "Of course.", QUESTIONS.anything_else), false, events);
  }

  // --- Next information to collect ---
  const q = nextQuestion(state, assessment);
  if (q) {
    state.stage = stageFor(q, d);
    return finish(state, rules, join(prefix, ack, ask(state, q)), false, events);
  }

  // --- Nothing more to ask: close according to disposition ---
  if (d === "QUALIFIED") {
    state.stage = "qualified";
    if (state.facts.consultationDeclined?.value) {
      state.closingSent = true;
      state.lastQuestion = "anything_else";
      return finish(state, rules, join(prefix, ack, qualifiedClosing(firstName(state), undefined)), false, events);
    }
    if (!state.facts.consultationRequested?.value && (state.asked.consultation_offer ?? 0) < 1) {
      return finish(state, rules, join(prefix, ack, ask(state, "consultation_offer")), false, events);
    }
    if (state.facts.consultationRequested?.value && !state.facts.consultationPreference && (state.asked.consultation_time ?? 0) < 2) {
      return finish(state, rules, join(prefix, ack, ask(state, "consultation_time")), false, events);
    }
    state.closingSent = true;
    state.lastQuestion = "anything_else";
    if (state.facts.consultationPreference) events.push({ type: "consultation_requested", preference: state.facts.consultationPreference.value });
    return finish(state, rules, join(prefix, ack, qualifiedClosing(firstName(state), state.facts.consultationPreference?.value)), false, events);
  }
  if (d === "HUMAN_REVIEW") {
    state.stage = "human_review";
    state.closingSent = true;
    state.lastQuestion = "anything_else";
    return finish(state, rules, join(prefix, ack, reviewClosing(firstName(state))), false, events);
  }
  // INCOMPLETE after asking everything we reasonably can.
  state.stage = "completed";
  state.closingSent = true;
  state.endReason = "completed";
  return finish(state, rules, join(prefix, incompleteClosing(firstName(state))), true, events);
}

function complaintFlow(
  state: ConversationState,
  rules: RuleConfig,
  events: EngineEvent[],
  signals: Signals,
  intent: "complaint" | "existing_client",
): TurnOutput {
  const isComplaint = intent === "complaint";
  if (state.stage !== "complaint_escalation" && state.stage !== "existing_client_identification") {
    events.push(isComplaint ? { type: "complaint_detected" } : { type: "existing_client_request" });
  }
  state.stage = isComplaint ? "complaint_escalation" : "existing_client_identification";
  const f = state.facts;
  if (state.closingSent) {
    if (signals.goodbye || signals.negative) {
      state.endReason = "caller_ended";
      return finish(state, rules, LINES.closingGeneric, true, events);
    }
    // Additional details are appended to the escalation by the service layer.
    state.lastQuestion = "anything_else";
    return finish(state, rules, "Thank you, I've added that to the escalation. Is there anything else?", false, events);
  }
  if (!f.callerName && (state.asked.complaint_name ?? 0) < 2) {
    const line = isComplaint ? QUESTIONS.complaint_name : QUESTIONS.name;
    state.asked.complaint_name = (state.asked.complaint_name ?? 0) + 1;
    state.lastQuestion = "complaint_name";
    return finish(state, rules, line, false, events);
  }
  if (!f.locality && !f.existingDesigner && (state.asked.complaint_project ?? 0) < 1) {
    return finish(state, rules, ask(state, "complaint_project"), false, events);
  }
  if (!isComplaint && (state.asked.existing_message ?? 0) < 1 && !f.complaintSummary) {
    return finish(state, rules, ask(state, "existing_message"), false, events);
  }
  if (isComplaint && (!f.complaintSummary || f.complaintSummary.value.length < 25) && (state.asked.complaint_issue ?? 0) < 1) {
    return finish(state, rules, ask(state, "complaint_issue"), false, events);
  }
  state.closingSent = true;
  state.lastQuestion = "anything_else";
  return finish(state, rules, isComplaint ? complaintClosing(firstName(state)) : join(LINES.existingDone, QUESTIONS.anything_else), false, events);
}
