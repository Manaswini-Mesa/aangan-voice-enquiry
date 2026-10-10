// Merges newly extracted facts into the running fact set.
//
// Rules:
//  - A new value for an unknown fact is accepted.
//  - The same value again raises confidence (repetition confirms).
//  - A different value replaces the old one when the caller signals a correction, when it
//    answers the question we just asked about that fact, or when the old value was weak.
//  - Otherwise the change is recorded as a CONFLICT and the engine asks the caller to confirm.
//  - Caller statements outrank AI inferences and provider extractions; staff entries outrank all.

import type { EnquiryFacts, Fact, FactKey, FactSource } from "../types";
import type { QuestionKey } from "./rules-extractor";

export interface FactConflict {
  key: FactKey;
  previous: Fact<unknown>;
  incoming: Fact<unknown>;
  resolved: boolean;
  turn?: number;
}

export interface MergeOptions {
  correction: boolean;
  lastQuestion: QuestionKey | null;
}

const SOURCE_RANK: Record<FactSource, number> = {
  provider_extracted: 1,
  ai_inferred: 2,
  system: 3,
  caller_stated: 4,
  staff_entered: 5,
};

/** Facts that are lists/free text and simply accumulate or overwrite without conflict. */
const NON_CONFLICTING: FactKey[] = [
  "rooms",
  "timelineText",
  "complaintSummary",
  "consultationPreference",
  "budgetText",
  "budgetScope",
  "referral",
  "consultationRequested",
  "consultationDeclined",
  "intent",
  "desiredStartWeeks",
  "projectCategory",
  "propertyType",
  "onBehalfOf",
  "localityClaimedInArea",
];

/** Which question directly asks about which fact (answering it counts as an update). */
const QUESTION_FACTS: Partial<Record<QuestionKey, FactKey[]>> = {
  scope: ["scopeSize", "rooms", "engagement"],
  engagement: ["engagement"],
  location: ["locality"],
  location_choice: ["locality"],
  structural: ["structuralWork"],
  area: ["areaSqft"],
  timeline: ["completionWeeks", "timelineFlexible", "completionAsap"],
  timeline_specific: ["completionWeeks", "timelineFlexible", "completionAsap"],
  site_ready: ["siteReadyWeeks"],
  authority: ["authority"],
  authority_followup: ["authority"],
  name: ["callerName"],
  complaint_name: ["callerName"],
  phone: ["phone"],
  confirm_value: [],
};

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= Math.max(1, Math.abs(a) * 0.15);
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ca = (a as { canonical?: string; raw?: string }).canonical ?? (a as { raw?: string }).raw;
    const cb = (b as { canonical?: string; raw?: string }).canonical ?? (b as { raw?: string }).raw;
    if (ca !== undefined || cb !== undefined) return ca === cb;
    return JSON.stringify(a) === JSON.stringify(b);
  }
  if (typeof a === "string" && typeof b === "string") return a.trim().toLowerCase() === b.trim().toLowerCase();
  return a === b;
}

export function mergeFacts(
  current: EnquiryFacts,
  incoming: Partial<EnquiryFacts>,
  opts: MergeOptions,
): { facts: EnquiryFacts; conflicts: FactConflict[]; changed: FactKey[] } {
  const facts: EnquiryFacts = { ...current };
  const conflicts: FactConflict[] = [];
  const changed: FactKey[] = [];
  const answered = new Set(opts.lastQuestion ? QUESTION_FACTS[opts.lastQuestion] ?? [] : []);

  for (const key of Object.keys(incoming) as FactKey[]) {
    const next = incoming[key] as Fact<unknown> | undefined;
    if (!next) continue;
    const prev = facts[key] as Fact<unknown> | undefined;
    const write = (f: Fact<unknown>) => {
      (facts as Record<string, unknown>)[key] = f;
      changed.push(key);
    };

    if (!prev) {
      write(next);
      continue;
    }
    if (key === "intent") {
      // Intent is sticky: a complaint or existing-client call is never downgraded by later turns.
      const rank: Record<string, number> = { other: 0, new_enquiry: 1, existing_client: 2, complaint: 3 };
      if ((rank[String(next.value)] ?? 0) > (rank[String(prev.value)] ?? 0)) write(next);
      continue;
    }
    if (key === "scopeSize" && !opts.correction) {
      // Listing rooms after "full home" is elaboration, not a contradiction: keep the broader scope.
      const breadth: Record<string, number> = { partial: 0, single_room: 1, multi_room: 2, full_floor: 3, full_home: 4 };
      if ((breadth[String(next.value)] ?? 0) > (breadth[String(prev.value)] ?? 0)) write(next);
      continue;
    }
    if (key === "rooms") {
      const merged = [...new Set([...(prev.value as string[]), ...(next.value as string[])])];
      write({ ...next, value: merged });
      continue;
    }
    if (sameValue(prev.value, next.value)) {
      // Repetition confirms. Keep the higher-ranked source; raise confidence.
      const better = SOURCE_RANK[next.source] >= SOURCE_RANK[prev.source] ? next : prev;
      write({ ...better, confidence: Math.min(0.99, Math.max(prev.confidence, next.confidence) + 0.05), validation: "valid" });
      continue;
    }
    if (SOURCE_RANK[next.source] < SOURCE_RANK[prev.source]) {
      // Lower-trust source disagrees with what the caller said: keep caller value, note conflict
      // only if the lower-trust value was confident.
      if (next.confidence >= 0.8) conflicts.push({ key, previous: prev, incoming: next, resolved: false, turn: next.turn });
      continue;
    }
    if (NON_CONFLICTING.includes(key) || opts.correction || answered.has(key) || prev.confidence < 0.6 || next.source === "staff_entered") {
      write({ ...next, validation: "valid" });
      continue;
    }
    // Unprompted change to a confident value: record conflict, keep both visible.
    conflicts.push({ key, previous: prev, incoming: next, resolved: false, turn: next.turn });
    write({ ...next, validation: "conflict", confidence: Math.min(next.confidence, 0.55) });
  }
  return { facts, conflicts, changed };
}
