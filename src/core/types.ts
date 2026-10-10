// Shared domain types for the Aangan enquiry system.
// Everything in src/core is pure TypeScript: no database, network, LLM or framework imports.

export type FactSource =
  | "caller_stated" // the caller said it, captured from their own words
  | "ai_inferred" // an LLM inferred it; lower trust
  | "provider_extracted" // returned by the voice provider's post-call extraction
  | "staff_entered" // entered by an authenticated staff member
  | "system"; // e.g. caller ID from telephony

export type FactValidation = "valid" | "unverified" | "conflict";

export interface Fact<T> {
  value: T;
  source: FactSource;
  /** 0..1. Combines extraction certainty and transcription confidence. */
  confidence: number;
  /** Short quote or reason supporting the value. */
  evidence?: string;
  turn?: number;
  validation?: FactValidation;
}

export type Intent = "new_enquiry" | "existing_client" | "complaint" | "other";
export type ProjectCategory = "residential" | "commercial";
export type PropertyType =
  | "apartment"
  | "villa"
  | "independent_house"
  | "office"
  | "clinic"
  | "studio"
  | "coworking"
  | "restaurant"
  | "cafe"
  | "hotel"
  | "retail"
  | "gym"
  | "salon"
  | "other_commercial";

export type Engagement =
  | "design_and_execution"
  | "advice_only"
  | "styling_only"
  | "furniture_sourcing"
  | "vastu_only"
  | "design_only";

export type ScopeSize = "full_home" | "full_floor" | "multi_room" | "single_room" | "partial";
export type Authority =
  | "decision_maker"
  | "authorized_representative"
  | "researching_for_others";

export interface BudgetInr {
  min?: number;
  max?: number;
}

export interface LocalityValue {
  /** Text as the caller said it (normalised). */
  raw: string;
  /** Canonical locality name, when recognised. */
  canonical?: string;
  /** Other places mentioned in the same breath, when ambiguous. */
  alternatives?: string[];
}

export interface EnquiryFacts {
  intent?: Fact<Intent>;
  callerName?: Fact<string>;
  phone?: Fact<string>;
  email?: Fact<string>;
  projectCategory?: Fact<ProjectCategory>;
  propertyType?: Fact<PropertyType>;
  bhk?: Fact<number>;
  locality?: Fact<LocalityValue>;
  /** Caller confirmed an unrecognised locality is inside Pune/PCMC. Unverified. */
  localityClaimedInArea?: Fact<boolean>;
  areaSqft?: Fact<number>;
  engagement?: Fact<Engagement>;
  scopeSize?: Fact<ScopeSize>;
  rooms?: Fact<string[]>;
  structuralWork?: Fact<"none" | "required">;
  ownership?: Fact<"owned" | "rented">;
  /** Weeks from the enquiry date until the caller needs the project complete. */
  completionWeeks?: Fact<number>;
  /** Caller needs it urgently/ASAP but gave no date. */
  completionAsap?: Fact<boolean>;
  timelineText?: Fact<string>;
  timelineFlexible?: Fact<boolean>;
  /** Weeks from the enquiry date until the site is available for execution (0 = now). */
  siteReadyWeeks?: Fact<number>;
  /** Weeks from the enquiry date until the caller wants work to start. */
  desiredStartWeeks?: Fact<number>;
  budgetInr?: Fact<BudgetInr>;
  budgetText?: Fact<string>;
  budgetScope?: Fact<string>;
  budgetDeclined?: Fact<boolean>;
  authority?: Fact<Authority>;
  /** Someone else (e.g. parents) owns/decides; captured for the brief. */
  onBehalfOf?: Fact<string>;
  consultationRequested?: Fact<boolean>;
  consultationDeclined?: Fact<boolean>;
  consultationPreference?: Fact<string>;
  complaintSummary?: Fact<string>;
  existingDesigner?: Fact<string>;
  referral?: Fact<string>;
}

export type FactKey = keyof EnquiryFacts;

export type CriterionId =
  | "SCOPE"
  | "LOCATION"
  | "TIMELINE"
  | "BUDGET"
  | "AUTHORITY"
  | "COMMERCIAL_SIZE";

export type CriterionState = "PASS" | "FAIL" | "UNKNOWN" | "REVIEW";

export interface CriterionEvidence {
  fact: FactKey;
  value: unknown;
  source: FactSource;
  confidence: number;
}

export interface CriterionResult {
  id: CriterionId;
  label: string;
  state: CriterionState;
  applicable: boolean;
  /** Plain-English explanation, for staff. */
  reasons: string[];
  evidence: CriterionEvidence[];
  /** True when an UNKNOWN on this criterion prevents qualification (scope, location, timeline). */
  critical: boolean;
  /** For REVIEW: if mandatory, review takes precedence over failure counts. */
  mandatoryReview?: boolean;
  /** Code naming the rule that produced the result, for traceability. */
  ruleCode: string;
  /** Set when the decision rests on an unconfirmed business rule. */
  provisionalRule?: string;
}

export type Disposition =
  | "QUALIFIED"
  | "NOT_QUALIFIED" // exactly one confirmed failure
  | "DECLINED" // two or more confirmed failures
  | "HUMAN_REVIEW"
  | "INCOMPLETE"
  | "COMPLAINT_ESCALATION"
  | "EXISTING_CLIENT_REQUEST";

export interface ReviewReason {
  code: string;
  message: string;
  mandatory: boolean;
  criterion?: CriterionId;
}

export interface Assessment {
  ruleVersion: string;
  disposition: Disposition;
  criteria: CriterionResult[];
  failures: CriterionId[];
  reviewReasons: ReviewReason[];
  /** Critical criteria still UNKNOWN. */
  missingCritical: CriterionId[];
  /** Non-blocking uncertainties to note in the handoff (budget/authority unknown). */
  notes: string[];
  /** Ordered list of precedence steps evaluated, for audit. */
  precedenceTrace: string[];
}
