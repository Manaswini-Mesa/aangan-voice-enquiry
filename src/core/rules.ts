// Versioned qualification rule configuration.
// Sources: docs/source/qualified.md (Nikhil's rubric) and docs/source/services.md.
// Every rule that is not explicitly documented is marked PENDING_CONFIRMATION and
// produces a human-review outcome instead of an automatic decline.

export type RuleStatus = "CONFIRMED" | "PENDING_CONFIRMATION" | "DISABLED";

export interface BudgetReviewFloors {
  /**
   * INTERNAL ONLY. Used server-side to flag a volunteered budget that looks clearly
   * below the described scope. Never spoken to callers, never sent to the LLM.
   * Values are configured via BUDGET_REVIEW_FLOORS (JSON). When unset, budget
   * plausibility cannot be judged and a volunteered budget is recorded as UNKNOWN.
   */
  perRoomInr?: number;
  residentialPerSqftInr?: number;
  commercialPerSqftInr?: number;
}

export interface RuleConfig {
  baseVersion: string;
  timeline: {
    /** services.md: "cannot begin execution on a project that needs to be ready in under 6 weeks". */
    hardMinimumWeeks: number;
    /** Design 3–4 weeks + execution from 8 weeks (services.md). At/above this a deadline is clearly feasible. */
    comfortableMinimumWeeks: number;
    /** qualified.md: site must be available for execution within 8–10 weeks of the consultation. */
    siteReadyMaxWeeks: number;
  };
  commercial: {
    /** services.md: offices up to approximately 3,000 sq ft. "Approximately" → larger goes to review. */
    maxSqft: number;
    /** Discussed after a 180 sq ft enquiry; NOT confirmed by Nikhil. */
    provisionalMinSqft: number;
    provisionalMinStatus: RuleStatus;
  };
  residential: {
    /** services.md: full home is 2BHK onwards. */
    fullHomeMinBhk: number;
  };
  budget: {
    status: RuleStatus;
    /**
     * qualified.md's own example of a budget "clearly below what any project of their
     * described scope would cost": ₹1–1.5 lakh for a full flat redesign. Applied to
     * multi-room, full-floor and full-home scopes only.
     */
    documentedClearlyLowMaxInr: number;
    floors: BudgetReviewFloors;
  };
  /** Facts below this confidence cannot drive a FAIL; they trigger clarification/review. */
  minDecisiveConfidence: number;
}

export const DEFAULT_RULES: RuleConfig = {
  baseVersion: "2026.10.1",
  timeline: { hardMinimumWeeks: 6, comfortableMinimumWeeks: 12, siteReadyMaxWeeks: 10 },
  commercial: { maxSqft: 3000, provisionalMinSqft: 500, provisionalMinStatus: "PENDING_CONFIRMATION" },
  residential: { fullHomeMinBhk: 2 },
  budget: { status: "PENDING_CONFIRMATION", documentedClearlyLowMaxInr: 150000, floors: {} },
  minDecisiveConfidence: 0.6,
};

/** Stable JSON (sorted keys) so the same config always hashes the same way. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** FNV-1a 32-bit hash — small, deterministic, dependency-free. Not for security. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Rule version = base version + hash of the full config. Any config change yields a new version. */
export function ruleVersion(rules: RuleConfig): string {
  return `${rules.baseVersion}+${fnv1a(stableStringify(rules))}`;
}

export function buildRules(overrides?: {
  commercialMinStatus?: string;
  budgetFloorsJson?: string;
}): RuleConfig {
  const rules: RuleConfig = structuredClone(DEFAULT_RULES);
  const status = overrides?.commercialMinStatus?.toUpperCase();
  if (status === "CONFIRMED" || status === "DISABLED" || status === "PENDING_CONFIRMATION") {
    rules.commercial.provisionalMinStatus = status;
  }
  if (overrides?.budgetFloorsJson) {
    try {
      const parsed = JSON.parse(overrides.budgetFloorsJson) as Record<string, unknown>;
      const floors: BudgetReviewFloors = {};
      for (const key of ["perRoomInr", "residentialPerSqftInr", "commercialPerSqftInr"] as const) {
        const v = parsed[key];
        if (typeof v === "number" && Number.isFinite(v) && v > 0) floors[key] = v;
      }
      rules.budget.floors = floors;
    } catch {
      // Invalid JSON: leave floors empty (budget plausibility then stays UNKNOWN).
    }
  }
  return rules;
}
