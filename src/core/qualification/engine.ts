// Deterministic qualification engine.
//
// Inputs: facts + rule config. Output: per-criterion PASS/FAIL/UNKNOWN/REVIEW with evidence,
// and an overall disposition computed by an explicit precedence order (see decideDisposition).
// The same facts and the same rule version always produce the same assessment.

import { lookupLocality, findLocations } from "../locations";
import { ruleVersion, type RuleConfig } from "../rules";
import type {
  Assessment,
  CriterionEvidence,
  CriterionId,
  CriterionResult,
  Disposition,
  EnquiryFacts,
  Fact,
  FactKey,
  ReviewReason,
} from "../types";

const LABELS: Record<CriterionId, string> = {
  SCOPE: "Real project (design + execution, supported scope)",
  LOCATION: "In service area (Pune city / PCMC)",
  TIMELINE: "Realistic timeline",
  BUDGET: "Budget broadly aligned (only if volunteered)",
  AUTHORITY: "Decision-maker on the call (or authorised)",
  COMMERCIAL_SIZE: "Commercial size within documented range",
};

function ev(facts: EnquiryFacts, ...keys: FactKey[]): CriterionEvidence[] {
  return keys
    .map((k) => [k, facts[k] as Fact<unknown> | undefined] as const)
    .filter(([, f]) => f !== undefined)
    .map(([k, f]) => ({ fact: k, value: f!.value, source: f!.source, confidence: f!.confidence }));
}

function result(
  id: CriterionId,
  state: CriterionResult["state"],
  ruleCode: string,
  reasons: string[],
  evidence: CriterionEvidence[],
  extra: Partial<CriterionResult> = {},
): CriterionResult {
  return {
    id,
    label: LABELS[id],
    state,
    applicable: true,
    reasons,
    evidence,
    critical: id === "SCOPE" || id === "LOCATION" || id === "TIMELINE",
    ruleCode,
    ...extra,
  };
}

/** A FAIL needs a confident fact. Weak facts produce REVIEW (mandatory: clarify before deciding). */
function confirmedFail(
  id: CriterionId,
  f: Fact<unknown> | undefined,
  rules: RuleConfig,
  ruleCode: string,
  reasons: string[],
  evidence: CriterionEvidence[],
): CriterionResult {
  if (f && (f.confidence < rules.minDecisiveConfidence || f.validation === "unverified" || f.validation === "conflict")) {
    return result(id, "REVIEW", `${ruleCode}.LOW_CONFIDENCE`, [...reasons, "The deciding answer was unclear or conflicting, so it needs confirming before declining."], evidence, {
      mandatoryReview: true,
    });
  }
  return result(id, "FAIL", ruleCode, reasons, evidence);
}

const UNSUPPORTED_TYPES = new Set(["restaurant", "cafe", "hotel", "retail", "gym"]);

export function assessScope(facts: EnquiryFacts, rules: RuleConfig): CriterionResult {
  const e = ev(facts, "projectCategory", "propertyType", "engagement", "scopeSize", "rooms", "structuralWork", "ownership", "bhk");
  const type = facts.propertyType?.value;
  if (type && UNSUPPORTED_TYPES.has(type)) {
    return confirmedFail("SCOPE", facts.propertyType, rules, "SCOPE.UNSUPPORTED_COMMERCIAL_TYPE", [
      `Restaurants, hotels, retail and gyms are out of scope (services.md). Caller described: ${type}.`,
    ], e);
  }
  if (type === "salon" || type === "other_commercial") {
    return result("SCOPE", "REVIEW", "SCOPE.UNDOCUMENTED_COMMERCIAL_TYPE", [
      `Commercial type "${type}" is not listed as supported or excluded in services.md.`,
    ], e);
  }
  const engagement = facts.engagement?.value;
  if (engagement && engagement !== "design_and_execution") {
    const why: Record<string, string> = {
      advice_only: "Advice/ideas-only requests are not taken; minimum engagement is a room redesign with execution.",
      styling_only: "Decor, colour advice or furniture rearrangement alone is not offered.",
      furniture_sourcing: "Standalone furniture sourcing without a design project is not offered.",
      vastu_only: "Standalone Vastu consultation is not offered.",
      design_only: "Design without execution is not offered; projects include execution.",
    };
    return confirmedFail("SCOPE", facts.engagement, rules, `SCOPE.${engagement.toUpperCase()}`, [why[engagement]], e);
  }
  if (facts.structuralWork?.value === "required") {
    return confirmedFail("SCOPE", facts.structuralWork, rules, "SCOPE.STRUCTURAL", [
      "Structural work (moving/removing walls, structural changes) is outside scope — Aangan does not do architecture or structural work.",
    ], e);
  }
  if (!engagement || !facts.scopeSize) {
    const missing = [!engagement && "whether design and execution are both needed", !facts.scopeSize && "which spaces are involved"].filter(Boolean);
    return result("SCOPE", "UNKNOWN", "SCOPE.MISSING", [`Not yet known: ${missing.join(" and ")}.`], e);
  }
  if (facts.ownership?.value === "rented" && facts.structuralWork?.value !== "none") {
    return result("SCOPE", "UNKNOWN", "SCOPE.RENTED_STRUCTURAL_UNKNOWN", [
      "Rented property is fine only with no structural changes — not yet confirmed.",
    ], e);
  }
  const size = facts.scopeSize.value;
  if (size === "partial") {
    return result("SCOPE", "REVIEW", "SCOPE.PARTIAL_UNCLEAR", ["Scope is partial and does not clearly meet the one-complete-room minimum."], e);
  }
  if (size === "full_home" && facts.bhk && facts.bhk.value < rules.residential.fullHomeMinBhk) {
    return result("SCOPE", "REVIEW", "SCOPE.FULL_HOME_BELOW_2BHK", [
      `Full-home projects are listed as 2BHK onwards; caller has a ${facts.bhk.value}BHK. Needs a human decision.`,
    ], e);
  }
  const label = { full_home: "full home", full_floor: "full floor / fit-out", multi_room: "two or more rooms", single_room: "one complete room" }[size];
  const reasons = [`Design and execution for ${label}.`];
  if (facts.ownership?.value === "rented") reasons.push("Rented property with no structural changes — acceptable (qualified.md).");
  return result("SCOPE", "PASS", "SCOPE.SUPPORTED", reasons, e);
}

export function assessLocation(facts: EnquiryFacts, rules: RuleConfig): CriterionResult {
  const e = ev(facts, "locality", "localityClaimedInArea");
  const loc = facts.locality;
  if (!loc) return result("LOCATION", "UNKNOWN", "LOCATION.MISSING", ["Site location not yet known."], e);
  const entry = (loc.value.canonical ? lookupLocality(loc.value.canonical) : undefined) ?? findLocations(loc.value.raw)[0]?.entry;
  if (loc.value.alternatives?.length && loc.confidence < 0.7) {
    return result("LOCATION", "UNKNOWN", "LOCATION.AMBIGUOUS", [
      `Several places mentioned (${[loc.value.canonical ?? loc.value.raw, ...loc.value.alternatives].join(", ")}); site location needs confirming.`,
    ], e);
  }
  if (!entry) {
    if (facts.localityClaimedInArea?.value === false) {
      return confirmedFail("LOCATION", facts.localityClaimedInArea, rules, "LOCATION.CALLER_SAYS_OUTSIDE", [`"${loc.value.raw}" — caller said it is outside Pune city/PCMC.`], e);
    }
    return result("LOCATION", "REVIEW", "LOCATION.UNRECOGNISED", [
      `"${loc.value.raw}" is not in the service-area list${facts.localityClaimedInArea?.value ? " (caller says it is within Pune/PCMC — unverified)" : ""}. A person should confirm.`,
    ], e);
  }
  switch (entry.zone) {
    case "documented":
      return result("LOCATION", "PASS", "LOCATION.DOCUMENTED", [`${entry.canonical} is named in the service area (${entry.area}).`], e);
    case "known_city":
      return result("LOCATION", "PASS", "LOCATION.WITHIN_LIMITS", [`${entry.canonical} is within ${entry.area} limits ("adjoining areas" in services.md).`], e);
    case "fringe":
      return result("LOCATION", "REVIEW", "LOCATION.FRINGE", [`${entry.canonical} is on the edge of Pune/PCMC; coverage is not documented.`], e);
    case "excluded":
      return confirmedFail("LOCATION", loc, rules, "LOCATION.EXCLUDED", [`${entry.canonical} is explicitly not served (services.md).`], e);
    case "other_city":
      return confirmedFail("LOCATION", loc, rules, "LOCATION.OTHER_CITY", [`${entry.canonical} is outside Pune city and PCMC.`], e);
    case "broad":
    default:
      return result("LOCATION", "UNKNOWN", "LOCATION.TOO_BROAD", ["Only a broad area was given; the specific locality is needed."], e);
  }
}

export function assessTimeline(facts: EnquiryFacts, rules: RuleConfig): CriterionResult {
  const e = ev(facts, "completionWeeks", "completionAsap", "timelineFlexible", "siteReadyWeeks", "desiredStartWeeks", "timelineText");
  const { hardMinimumWeeks, comfortableMinimumWeeks, siteReadyMaxWeeks } = rules.timeline;
  const completion = facts.completionWeeks;
  const site = facts.siteReadyWeeks;
  const reasons: string[] = [];

  if (completion) {
    const w = completion.value;
    if (w < hardMinimumWeeks) {
      return confirmedFail("TIMELINE", completion, rules, "TIMELINE.BELOW_HARD_MINIMUM", [
        `Needs completion in about ${w} weeks; services.md: cannot begin execution on a project that must be ready in under ${hardMinimumWeeks} weeks (design alone takes 3–4 weeks).`,
      ], e);
    }
    if (w < comfortableMinimumWeeks) {
      return result("TIMELINE", "REVIEW", "TIMELINE.BORDERLINE", [
        `Needs completion in about ${w} weeks — above the ${hardMinimumWeeks}-week hard minimum but below the ~${comfortableMinimumWeeks} weeks that design (3–4 wks) plus execution (from 8 wks) normally needs. A designer should judge feasibility.`,
      ], e);
    }
    reasons.push(`Completion needed in about ${w} weeks — feasible against design (3–4 wks) + execution (8–16 wks).`);
  } else if (facts.timelineFlexible?.value) {
    reasons.push("Caller's timeline is flexible.");
  } else if (facts.desiredStartWeeks && !facts.completionAsap) {
    reasons.push(`Caller wants to start in about ${facts.desiredStartWeeks.value} weeks with no fixed completion deadline.`);
  } else if (facts.completionAsap?.value) {
    return result("TIMELINE", "UNKNOWN", "TIMELINE.ASAP_NO_DATE", ["Caller wants it as soon as possible but gave no completion date — needs a specific date."], e);
  } else {
    return result("TIMELINE", "UNKNOWN", "TIMELINE.MISSING", ["Completion timeline not yet known."], e);
  }

  if (site && site.value > siteReadyMaxWeeks) {
    return result("TIMELINE", "REVIEW", "TIMELINE.SITE_NOT_READY_IN_WINDOW", [
      ...reasons,
      `Site available in about ${site.value} weeks; qualified.md expects the site to be available within ${siteReadyMaxWeeks - 2}–${siteReadyMaxWeeks} weeks of the consultation.`,
    ], e);
  }
  if (completion && site && completion.value - site.value < 8) {
    return result("TIMELINE", "REVIEW", "TIMELINE.SITE_TO_DEADLINE_TOO_SHORT", [
      ...reasons,
      `Only about ${Math.max(0, Math.round(completion.value - site.value))} weeks between site availability and the deadline; execution takes 8–16 weeks.`,
    ], e);
  }
  if (site) reasons.push(site.value === 0 ? "Site is available now." : `Site available in about ${site.value} weeks (within the ${siteReadyMaxWeeks}-week window).`);
  else reasons.push("Site-readiness date not stated (non-blocking; designer to confirm).");
  return result("TIMELINE", "PASS", "TIMELINE.FEASIBLE", reasons, e);
}

function scopeRoomCount(facts: EnquiryFacts): number | undefined {
  if (facts.rooms) return facts.rooms.value.length;
  if (facts.scopeSize?.value === "single_room") return 1;
  if (facts.scopeSize?.value === "multi_room") return 2;
  return undefined;
}

export function assessBudget(facts: EnquiryFacts, rules: RuleConfig): CriterionResult {
  const e = ev(facts, "budgetInr", "budgetText", "budgetScope", "budgetDeclined");
  const budget = facts.budgetInr;
  if (!budget) {
    return result("BUDGET", "UNKNOWN", facts.budgetDeclined ? "BUDGET.NOT_SHARED" : "BUDGET.NOT_MENTIONED", [
      facts.budgetDeclined ? "Caller preferred not to share a budget — not a failure." : "Budget not mentioned — treated as qualified (qualified.md); designer establishes fit.",
    ], e, { critical: false });
  }
  const top = budget.value.max ?? budget.value.min ?? 0;
  const size = facts.scopeSize?.value;
  const reasons: string[] = [];
  const largeScope = size === "full_home" || size === "full_floor" || size === "multi_room";
  if (largeScope && top <= rules.budget.documentedClearlyLowMaxInr) {
    return result("BUDGET", "REVIEW", "BUDGET.DOCUMENTED_CLEARLY_LOW", [
      "Volunteered budget is at or below the level qualified.md gives as clearly too low for a multi-room/full-home redesign. Not forwarded as qualified; a person should address the misalignment. No price was quoted to the caller.",
    ], e, { critical: false });
  }
  const f = rules.budget.floors;
  let floor: number | undefined;
  const rooms = scopeRoomCount(facts);
  const area = facts.areaSqft?.value;
  const commercial = facts.projectCategory?.value === "commercial";
  if (commercial && area && f.commercialPerSqftInr) floor = area * f.commercialPerSqftInr;
  else if (!commercial) {
    const byRooms = rooms && f.perRoomInr ? rooms * f.perRoomInr : undefined;
    const byArea = area && size === "full_home" && f.residentialPerSqftInr ? area * f.residentialPerSqftInr : undefined;
    floor = Math.max(byRooms ?? 0, byArea ?? 0) || undefined;
  }
  if (floor === undefined) {
    reasons.push("Budget recorded. Plausibility check needs configured internal review floors (BUDGET_REVIEW_FLOORS) or a clearer scope; designer to assess.");
    return result("BUDGET", "UNKNOWN", "BUDGET.NO_BASIS", reasons, e, { critical: false });
  }
  if (top < floor) {
    return result("BUDGET", "REVIEW", "BUDGET.BELOW_INTERNAL_FLOOR", [
      "Volunteered budget appears below the internal review floor for the described scope. Needs a person to check before booking. No price was quoted to the caller.",
    ], e, { critical: false, provisionalRule: rules.budget.status === "PENDING_CONFIRMATION" ? "Budget review floors are pending business confirmation" : undefined });
  }
  return result("BUDGET", "PASS", "BUDGET.PLAUSIBLE", ["Volunteered budget does not appear misaligned with the scope."], e, { critical: false });
}

export function assessAuthority(facts: EnquiryFacts): CriterionResult {
  const e = ev(facts, "authority", "onBehalfOf");
  const a = facts.authority?.value;
  if (a === "decision_maker") return result("AUTHORITY", "PASS", "AUTHORITY.DECISION_MAKER", ["Caller is the decision-maker."], e, { critical: false });
  if (a === "authorized_representative") {
    return result("AUTHORITY", "PASS", "AUTHORITY.AUTHORISED", [`Caller is authorised to act${facts.onBehalfOf ? ` for their ${facts.onBehalfOf.value}` : ""}.`], e, { critical: false });
  }
  if (a === "researching_for_others") {
    return result("AUTHORITY", "REVIEW", "AUTHORITY.RESEARCH_ONLY", [
      `Caller is researching${facts.onBehalfOf ? ` for their ${facts.onBehalfOf.value}` : " for someone else"} without confirmed authority — "not sufficient on its own" (qualified.md).`,
    ], e, { critical: false });
  }
  return result("AUTHORITY", "UNKNOWN", "AUTHORITY.UNCERTAIN", [
    facts.onBehalfOf ? `Calling about their ${facts.onBehalfOf.value}'s property; authority not established.` : "Decision-making authority not established — non-blocking; note in handoff.",
  ], e, { critical: false });
}

export function assessCommercialSize(facts: EnquiryFacts, rules: RuleConfig): CriterionResult {
  const e = ev(facts, "projectCategory", "propertyType", "areaSqft");
  const commercial = facts.projectCategory?.value === "commercial" && !UNSUPPORTED_TYPES.has(facts.propertyType?.value ?? "");
  if (!commercial) {
    return { ...result("COMMERCIAL_SIZE", "PASS", "COMMERCIAL_SIZE.NOT_APPLICABLE", ["Not a supported commercial project — not applicable."], e, { critical: false }), applicable: false };
  }
  const area = facts.areaSqft;
  if (!area) return result("COMMERCIAL_SIZE", "UNKNOWN", "COMMERCIAL_SIZE.MISSING", ["Commercial area not yet known."], e, { critical: false });
  const { provisionalMinSqft, provisionalMinStatus, maxSqft } = rules.commercial;
  if (area.value > maxSqft) {
    return result("COMMERCIAL_SIZE", "REVIEW", "COMMERCIAL_SIZE.ABOVE_APPROX_MAX", [
      `${area.value} sq ft is above the approximately ${maxSqft} sq ft commercial limit in services.md.`,
    ], e, { critical: false });
  }
  if (area.value < provisionalMinSqft && provisionalMinStatus !== "DISABLED") {
    if (provisionalMinStatus === "CONFIRMED") {
      return confirmedFail("COMMERCIAL_SIZE", area, rules, "COMMERCIAL_SIZE.BELOW_MINIMUM", [`${area.value} sq ft is below the confirmed ${provisionalMinSqft} sq ft commercial minimum.`], e);
    }
    return result("COMMERCIAL_SIZE", "REVIEW", "COMMERCIAL_SIZE.PROVISIONAL_MINIMUM", [
      `${area.value} sq ft is below the provisional ${provisionalMinSqft} sq ft commercial minimum. This rule is PENDING_CONFIRMATION by Nikhil, so it cannot decline automatically.`,
    ], e, { critical: false, mandatoryReview: true, provisionalRule: `Commercial minimum ${provisionalMinSqft} sq ft — PENDING_CONFIRMATION` });
  }
  return result("COMMERCIAL_SIZE", "PASS", "COMMERCIAL_SIZE.WITHIN_RANGE", [`${area.value} sq ft is within the documented commercial range.`], e, { critical: false });
}

/**
 * Overall disposition — precedence order (first matching step wins):
 *  1. Complaint / existing-client intent → separate workflow.
 *  2. Any MANDATORY review condition (provisional rule, unresolved conflict, low-confidence
 *     decisive fact) → HUMAN_REVIEW, even when failures exist. Failures stay recorded.
 *  3. Two or more confirmed failures → DECLINED (respectful decline).
 *  4. Exactly one confirmed failure → NOT_QUALIFIED (respectful close), unless any review
 *     condition applies → HUMAN_REVIEW.
 *  5. Any other REVIEW condition → HUMAN_REVIEW.
 *  6. No failures but a critical criterion (scope/location/timeline) UNKNOWN → INCOMPLETE.
 *  7. Otherwise → QUALIFIED. Unknown budget/authority are non-blocking notes.
 */
export function decideDisposition(
  facts: EnquiryFacts,
  criteria: CriterionResult[],
  extraReview: ReviewReason[] = [],
): Pick<Assessment, "disposition" | "failures" | "reviewReasons" | "missingCritical" | "notes" | "precedenceTrace"> {
  const trace: string[] = [];
  const failures = criteria.filter((c) => c.applicable && c.state === "FAIL").map((c) => c.id);
  const reviewReasons: ReviewReason[] = [
    ...criteria
      .filter((c) => c.applicable && c.state === "REVIEW")
      .map((c) => ({ code: c.ruleCode, message: c.reasons.join(" "), mandatory: !!c.mandatoryReview, criterion: c.id })),
    ...extraReview,
  ];
  const missingCritical = criteria.filter((c) => c.applicable && c.critical && c.state === "UNKNOWN").map((c) => c.id);
  const notes = criteria
    .filter((c) => c.applicable && !c.critical && c.state === "UNKNOWN")
    .map((c) => `${c.label}: ${c.reasons.join(" ")}`);

  const intent = facts.intent?.value;
  const done = (disposition: Disposition) => ({ disposition, failures, reviewReasons, missingCritical, notes, precedenceTrace: trace });

  trace.push(`1. intent=${intent ?? "unknown"}`);
  if (intent === "complaint") return done("COMPLAINT_ESCALATION");
  if (intent === "existing_client") return done("EXISTING_CLIENT_REQUEST");

  const mandatory = reviewReasons.filter((r) => r.mandatory);
  trace.push(`2. mandatory review conditions=${mandatory.length}`);
  if (mandatory.length) return done("HUMAN_REVIEW");

  trace.push(`3. confirmed failures=${failures.length}`);
  if (failures.length >= 2) return done("DECLINED");

  trace.push(`4. single failure with review conditions=${failures.length === 1 && reviewReasons.length > 0}`);
  if (failures.length === 1) return done(reviewReasons.length ? "HUMAN_REVIEW" : "NOT_QUALIFIED");

  trace.push(`5. review conditions=${reviewReasons.length}`);
  if (reviewReasons.length) return done("HUMAN_REVIEW");

  trace.push(`6. missing critical=${missingCritical.join(",") || "none"}`);
  if (missingCritical.length) return done("INCOMPLETE");

  trace.push("7. all required criteria satisfied");
  return done("QUALIFIED");
}

export function assess(facts: EnquiryFacts, rules: RuleConfig, extraReview: ReviewReason[] = []): Assessment {
  const criteria = [
    assessScope(facts, rules),
    assessLocation(facts, rules),
    assessTimeline(facts, rules),
    assessBudget(facts, rules),
    assessAuthority(facts),
    assessCommercialSize(facts, rules),
  ];
  return { ruleVersion: ruleVersion(rules), criteria, ...decideDisposition(facts, criteria, extraReview) };
}
