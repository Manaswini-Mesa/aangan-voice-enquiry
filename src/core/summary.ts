// Deterministic call summary and designer brief, built only from validated facts.
// Used in demo mode, as the fallback when the LLM is unavailable, and always for the
// structured parts of the handoff brief.

import type { Assessment, EnquiryFacts } from "./types";

export function scopeSummary(f: EnquiryFacts): string | undefined {
  const parts: string[] = [];
  if (f.bhk) parts.push(`${f.bhk.value}BHK`);
  if (f.propertyType && !f.bhk) parts.push(f.propertyType.value.replace(/_/g, " "));
  const size = f.scopeSize?.value;
  if (size) parts.push({ full_home: "full home", full_floor: "full space / floor", multi_room: "multiple rooms", single_room: "single room", partial: "partial" }[size]);
  if (f.rooms?.value.length) parts.push(`(${f.rooms.value.join(", ")})`);
  if (f.engagement) parts.push(f.engagement.value === "design_and_execution" ? "— design + execution" : `— ${f.engagement.value.replace(/_/g, " ")}`);
  if (f.ownership) parts.push(`· ${f.ownership.value}`);
  if (f.structuralWork) parts.push(`· structural: ${f.structuralWork.value}`);
  return parts.length ? parts.join(" ") : undefined;
}

export function timelineSummary(f: EnquiryFacts): string | undefined {
  const parts: string[] = [];
  if (f.completionWeeks) parts.push(`complete in ~${f.completionWeeks.value} wks`);
  if (f.completionAsap) parts.push("wants it ASAP (no date)");
  if (f.timelineFlexible) parts.push("flexible");
  if (f.desiredStartWeeks) parts.push(f.desiredStartWeeks.value === 0 ? "start now" : `start in ~${f.desiredStartWeeks.value} wks`);
  if (f.siteReadyWeeks) parts.push(f.siteReadyWeeks.value === 0 ? "site available now" : `site available in ~${f.siteReadyWeeks.value} wks`);
  if (f.timelineText && !parts.length) parts.push(`"${f.timelineText.value}"`);
  return parts.length ? parts.join(", ") : undefined;
}

export function authorityLabel(f: EnquiryFacts): string {
  const a = f.authority?.value;
  if (a === "decision_maker") return "Decision-maker";
  if (a === "authorized_representative") return `Authorised representative${f.onBehalfOf ? ` (for ${f.onBehalfOf.value})` : ""}`;
  if (a === "researching_for_others") return `Researching for ${f.onBehalfOf?.value ?? "someone else"} — authority not confirmed`;
  return f.onBehalfOf ? `Unknown (calling about their ${f.onBehalfOf.value}'s property)` : "Unknown";
}

export function deterministicSummary(f: EnquiryFacts, a: Assessment): string {
  const who = f.callerName?.value ?? "Caller";
  if (a.disposition === "COMPLAINT_ESCALATION") {
    return `${who} called with a complaint about an existing project${f.locality ? ` in ${f.locality.value.canonical ?? f.locality.value.raw}` : ""}${f.existingDesigner ? ` (designer: ${f.existingDesigner.value})` : ""}. Caller said: "${(f.complaintSummary?.value ?? "").slice(0, 300)}". Escalated to the senior team for a callback.`;
  }
  if (a.disposition === "EXISTING_CLIENT_REQUEST") {
    return `${who} is an existing client. Message: "${(f.complaintSummary?.value ?? "not captured").slice(0, 300)}".`;
  }
  const lines: string[] = [];
  const loc = f.locality ? f.locality.value.canonical ?? f.locality.value.raw : "location not given";
  lines.push(`${who} enquired about ${scopeSummary(f) ?? "an interior project (scope unclear)"} in ${loc}.`);
  const tl = timelineSummary(f);
  lines.push(tl ? `Timeline: ${tl}.` : "Timeline not established.");
  if (f.budgetText) lines.push(`Budget volunteered: ${f.budgetText.value}${f.budgetScope ? ` (${f.budgetScope.value})` : ""}.`);
  else lines.push(f.budgetDeclined ? "Preferred not to share a budget." : "Budget not discussed.");
  lines.push(`Authority: ${authorityLabel(f)}.`);
  if (f.consultationPreference) lines.push(`Consultation preference: "${f.consultationPreference.value}" (not confirmed).`);
  const outcome = {
    QUALIFIED: "All criteria met — ready for designer handoff.",
    HUMAN_REVIEW: `Needs human review: ${a.reviewReasons.map((r) => r.message).join(" ")}`,
    DECLINED: "Declined respectfully (two or more criteria failed).",
    NOT_QUALIFIED: `Closed respectfully — ${a.criteria.find((c) => c.state === "FAIL")?.reasons.join(" ") ?? "one criterion failed"}`,
    INCOMPLETE: `Incomplete — still needed: ${a.missingCritical.join(", ").toLowerCase()}.`,
  } as Record<string, string>;
  lines.push(outcome[a.disposition] ?? "");
  return lines.join(" ");
}

export interface DesignerBrief {
  leadRef: string;
  caller: { name?: string; phone?: string; email?: string };
  project: { category?: string; type?: string; locality?: string; area?: number; scope?: string; rooms?: string[]; execution?: string; structural?: string; ownership?: string };
  timeline?: string;
  budget?: string;
  authority: string;
  consultationPreference?: string;
  outstandingQuestions: string[];
  qualification: Array<{ criterion: string; state: string; reason: string }>;
  flags: string[];
  summary: string;
  nextAction: string;
  ruleVersion: string;
}

export function buildBrief(leadRef: string, f: EnquiryFacts, a: Assessment, summary: string): DesignerBrief {
  const outstanding: string[] = [];
  if (!f.areaSqft) outstanding.push("Carpet area");
  if (!f.siteReadyWeeks) outstanding.push("Site-readiness date");
  if (!f.authority) outstanding.push("Confirm decision-maker");
  if (!f.budgetInr) outstanding.push("Budget (not discussed on call — establish at consultation)");
  if (!f.email) outstanding.push("Email address");
  return {
    leadRef,
    caller: { name: f.callerName?.value, phone: f.phone?.value, email: f.email?.value },
    project: {
      category: f.projectCategory?.value,
      type: f.propertyType?.value,
      locality: f.locality ? f.locality.value.canonical ?? f.locality.value.raw : undefined,
      area: f.areaSqft?.value,
      scope: scopeSummary(f),
      rooms: f.rooms?.value,
      execution: f.engagement?.value === "design_and_execution" ? "Design + execution" : f.engagement?.value,
      structural: f.structuralWork?.value,
      ownership: f.ownership?.value,
    },
    timeline: timelineSummary(f),
    budget: f.budgetText ? `${f.budgetText.value}${f.budgetScope ? ` (${f.budgetScope.value})` : ""}` : undefined,
    authority: authorityLabel(f),
    consultationPreference: f.consultationPreference?.value,
    outstandingQuestions: outstanding,
    qualification: a.criteria.filter((c) => c.applicable).map((c) => ({ criterion: c.label, state: c.state, reason: c.reasons.join(" ") })),
    flags: [...a.notes, ...a.reviewReasons.map((r) => r.message)],
    summary,
    nextAction: f.consultationPreference
      ? "Confirm consultation slot with the caller (requested, not yet confirmed)."
      : "Call the client to arrange a consultation.",
    ruleVersion: a.ruleVersion,
  };
}
