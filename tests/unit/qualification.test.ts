import { describe, expect, it } from "vitest";
import { assess, assessAuthority, assessBudget, assessLocation, assessScope, assessTimeline, decideDisposition } from "@/core/qualification/engine";
import { buildRules, ruleVersion } from "@/core/rules";
import { SCENARIOS, scenarioById } from "@/core/scenarios";
import { APPROVED_PRICING_RESPONSE } from "@/core/pricing/policy";
import { f, facts, runScenario, runScript } from "../helpers";

const rules = buildRules();
const base = {
  projectCategory: f("residential" as const),
  bhk: f(3),
  engagement: f("design_and_execution" as const),
  scopeSize: f("full_home" as const),
  locality: f({ raw: "Kothrud", canonical: "Kothrud" }),
  completionWeeks: f(24),
  authority: f("decision_maker" as const),
};

const crit = (a: ReturnType<typeof assess>, id: string) => a.criteria.find((c) => c.id === id)!;

describe("acceptance scenarios P01–P18 (full conversation → disposition)", () => {
  for (const sc of SCENARIOS) {
    it(`${sc.id}: ${sc.title} → ${sc.expected}`, () => {
      const r = runScenario(sc);
      expect(r.assessment.disposition).toBe(sc.expected);
    });
  }

  it("P01 qualifies with every critical criterion PASS", () => {
    const a = runScenario(scenarioById("P01")!).assessment;
    expect(crit(a, "SCOPE").state).toBe("PASS");
    expect(crit(a, "LOCATION").state).toBe("PASS");
    expect(crit(a, "TIMELINE").state).toBe("PASS");
    expect(crit(a, "AUTHORITY").state).toBe("PASS");
  });

  it("P02 is declined specifically for location", () => {
    const a = runScenario(scenarioById("P02")!).assessment;
    expect(crit(a, "LOCATION").state).toBe("FAIL");
    expect(crit(a, "LOCATION").ruleCode).toBe("LOCATION.EXCLUDED");
  });

  it("P03 advice-only fails scope", () => {
    expect(crit(runScenario(scenarioById("P03")!).assessment, "SCOPE").ruleCode).toBe("SCOPE.ADVICE_ONLY");
  });

  it("P04 single complete room passes scope", () => {
    const a = runScenario(scenarioById("P04")!).assessment;
    expect(crit(a, "SCOPE").state).toBe("PASS");
    expect(crit(a, "SCOPE").reasons.join()).toMatch(/one complete room/);
  });

  it("P05 rented + non-structural passes scope", () => {
    const a = runScenario(scenarioById("P05")!).assessment;
    expect(crit(a, "SCOPE").state).toBe("PASS");
    expect(crit(a, "SCOPE").reasons.join()).toMatch(/Rented/);
  });

  it("P06 pricing question gets the exact approved response and qualification continues", () => {
    const r = runScenario(scenarioById("P06")!);
    expect(r.replies[0]).toBe(APPROVED_PRICING_RESPONSE);
    expect(r.replies.filter((x) => x.includes(APPROVED_PRICING_RESPONSE)).length).toBeGreaterThanOrEqual(2);
    expect(r.assessment.disposition).toBe("QUALIFIED");
  });

  it("P07 undisclosed budget is UNKNOWN, not a failure", () => {
    const a = runScenario(scenarioById("P07")!).assessment;
    expect(crit(a, "BUDGET").state).toBe("UNKNOWN");
    expect(a.failures).not.toContain("BUDGET");
  });

  it("P08 low volunteered budget → REVIEW, and no number is spoken back", () => {
    const r = runScenario(scenarioById("P08")!);
    expect(crit(r.assessment, "BUDGET").state).toBe("REVIEW");
    for (const reply of r.replies) expect(reply).not.toMatch(/₹|lakh|\brs\b|per sq/i);
  });

  it("P09 researching for parents is not treated as authorised", () => {
    const a = runScenario(scenarioById("P09")!).assessment;
    expect(crit(a, "AUTHORITY").state).toBe("REVIEW");
    expect(a.disposition).not.toBe("QUALIFIED");
  });

  it("P10 authorised representative passes authority", () => {
    expect(crit(runScenario(scenarioById("P10")!).assessment, "AUTHORITY").state).toBe("PASS");
  });

  it("P11 missing location → clarification question about the locality", () => {
    const r = runScenario(scenarioById("P11")!);
    expect(r.state.lastQuestion).toBe("location");
    expect(r.replies.at(-1)).toMatch(/area or locality/i);
    expect(r.assessment.missingCritical).toContain("LOCATION");
  });

  it("P12 three-week deadline fails timeline (never qualified)", () => {
    const a = runScenario(scenarioById("P12")!).assessment;
    expect(crit(a, "TIMELINE").state).toBe("FAIL");
    expect(a.disposition).not.toBe("QUALIFIED");
  });

  it("P13 borderline timeline → REVIEW", () => {
    const a = runScenario(scenarioById("P13")!).assessment;
    expect(crit(a, "TIMELINE").ruleCode).toBe("TIMELINE.BORDERLINE");
  });

  it("P14 complaint goes to escalation, not the enquiry pipeline", () => {
    const r = runScenario(scenarioById("P14")!);
    expect(r.assessment.disposition).toBe("COMPLAINT_ESCALATION");
    expect(r.state.stage).toBe("complaint_escalation");
  });

  it("P15 180 sq ft commercial → provisional rule, mandatory review, not auto-declined", () => {
    const a = runScenario(scenarioById("P15")!).assessment;
    const c = crit(a, "COMMERCIAL_SIZE");
    expect(c.state).toBe("REVIEW");
    expect(c.mandatoryReview).toBe(true);
    expect(c.provisionalRule).toMatch(/PENDING_CONFIRMATION/);
  });

  it("P16 structural wall removal fails scope", () => {
    expect(crit(runScenario(scenarioById("P16")!).assessment, "SCOPE").ruleCode).toBe("SCOPE.STRUCTURAL");
  });

  it("P17 disconnect before timeline → INCOMPLETE with facts preserved", () => {
    const r = runScenario(scenarioById("P17")!);
    expect(r.assessment.disposition).toBe("INCOMPLETE");
    expect(r.state.stage).toBe("disconnected");
    expect(r.state.facts.locality?.value.canonical).toBe("Pimple Saudagar");
    expect(r.assessment.missingCritical).toContain("TIMELINE");
  });

  it("P18 two confirmed failures → DECLINED with the qualified.md decline line", () => {
    const r = runScenario(scenarioById("P18")!);
    expect(r.assessment.failures.length).toBeGreaterThanOrEqual(2);
    expect(r.replies.join(" ")).toMatch(/may not be the right fit for us right now/);
  });
});

describe("criterion rules", () => {
  it("unknown is not fail: empty facts give UNKNOWN on critical criteria and INCOMPLETE overall", () => {
    const a = assess(facts({}), rules);
    expect(a.failures).toEqual([]);
    expect(a.disposition).toBe("INCOMPLETE");
    expect(crit(a, "SCOPE").state).toBe("UNKNOWN");
  });

  it("restaurants, hotels, retail and gyms fail scope", () => {
    for (const t of ["restaurant", "hotel", "retail", "gym"] as const) {
      expect(assessScope(facts({ projectCategory: f("commercial"), propertyType: f(t) }), rules).state).toBe("FAIL");
    }
  });

  it("standalone sourcing / vastu / styling / design-only fail scope", () => {
    for (const e of ["furniture_sourcing", "vastu_only", "styling_only", "design_only"] as const) {
      expect(assessScope(facts({ engagement: f(e), scopeSize: f("full_home") }), rules).state).toBe("FAIL");
    }
  });

  it("rented property with structural status unknown stays UNKNOWN (not pass, not fail)", () => {
    const s = assessScope(facts({ ...base, ownership: f("rented") }), rules);
    expect(s.state).toBe("UNKNOWN");
  });

  it("full-home 1BHK goes to review (documented scope is 2BHK onwards)", () => {
    expect(assessScope(facts({ ...base, bhk: f(1) }), rules).state).toBe("REVIEW");
  });

  it("location zones: documented PASS, known PASS, fringe REVIEW, excluded FAIL, broad UNKNOWN, unrecognised REVIEW", () => {
    const loc = (raw: string, canonical?: string) => assessLocation(facts({ locality: f({ raw, canonical }) }), rules).state;
    expect(loc("Baner", "Baner")).toBe("PASS");
    expect(loc("Kharadi", "Kharadi")).toBe("PASS");
    expect(loc("Wagholi", "Wagholi")).toBe("REVIEW");
    expect(loc("Talegaon", "Talegaon")).toBe("FAIL");
    expect(loc("Pune")).toBe("UNKNOWN");
    expect(loc("Xyzpur")).toBe("REVIEW");
  });

  it("a low-confidence location never produces an automatic FAIL", () => {
    const c = assessLocation(facts({ locality: f({ raw: "Nashik", canonical: "Nashik" }, 0.4) }), rules);
    expect(c.state).toBe("REVIEW");
    expect(c.mandatoryReview).toBe(true);
  });

  it("timeline thresholds: <6 FAIL, 6–12 REVIEW, ≥12 PASS, missing UNKNOWN, flexible PASS", () => {
    const t = (w: number) => assessTimeline(facts({ completionWeeks: f(w) }), rules).state;
    expect(t(3)).toBe("FAIL");
    expect(t(5.9)).toBe("FAIL");
    expect(t(6)).toBe("REVIEW");
    expect(t(9)).toBe("REVIEW");
    expect(t(12)).toBe("PASS");
    expect(t(30)).toBe("PASS");
    expect(assessTimeline(facts({}), rules).state).toBe("UNKNOWN");
    expect(assessTimeline(facts({ timelineFlexible: f(true) }), rules).state).toBe("PASS");
  });

  it("site not available within the 8–10 week window → REVIEW", () => {
    expect(assessTimeline(facts({ completionWeeks: f(40), siteReadyWeeks: f(20) }), rules).state).toBe("REVIEW");
    expect(assessTimeline(facts({ completionWeeks: f(40), siteReadyWeeks: f(4) }), rules).state).toBe("PASS");
  });

  it("deadline too close to site availability → REVIEW", () => {
    expect(assessTimeline(facts({ completionWeeks: f(14), siteReadyWeeks: f(8) }), rules).ruleCode).toBe("TIMELINE.SITE_TO_DEADLINE_TOO_SHORT");
  });

  it("budget: unknown when not mentioned; documented-low for full home → REVIEW; no basis → UNKNOWN", () => {
    expect(assessBudget(facts({}), rules).state).toBe("UNKNOWN");
    expect(assessBudget(facts({ scopeSize: f("full_home"), budgetInr: f({ min: 100000, max: 150000 }) }), rules).state).toBe("REVIEW");
    expect(assessBudget(facts({ scopeSize: f("full_home"), budgetInr: f({ min: 1500000, max: 2000000 }) }), rules).state).toBe("UNKNOWN");
  });

  it("budget floors (when configured internally) flag a low budget for review and pass a plausible one", () => {
    const r = buildRules({ budgetFloorsJson: JSON.stringify({ perRoomInr: 300000 }) });
    expect(assessBudget(facts({ scopeSize: f("multi_room"), rooms: f(["kitchen", "bedroom"]), budgetInr: f({ max: 400000 }) }), r).state).toBe("REVIEW");
    expect(assessBudget(facts({ scopeSize: f("multi_room"), rooms: f(["kitchen", "bedroom"]), budgetInr: f({ max: 900000 }) }), r).state).toBe("PASS");
  });

  it("authority: decision maker / representative PASS, research REVIEW, unknown UNKNOWN (non-blocking)", () => {
    expect(assessAuthority(facts({ authority: f("decision_maker") })).state).toBe("PASS");
    expect(assessAuthority(facts({ authority: f("authorized_representative") })).state).toBe("PASS");
    expect(assessAuthority(facts({ authority: f("researching_for_others") })).state).toBe("REVIEW");
    const unknown = assess(facts({ ...base, authority: undefined }), rules);
    expect(crit(unknown, "AUTHORITY").state).toBe("UNKNOWN");
    expect(unknown.disposition).toBe("QUALIFIED");
    expect(unknown.notes.join()).toMatch(/Decision-maker/);
  });

  it("commercial size: >3000 review; provisional minimum configurable (PENDING → REVIEW, CONFIRMED → FAIL, DISABLED → PASS)", () => {
    const office = (area: number) => facts({ projectCategory: f("commercial"), propertyType: f("office"), areaSqft: f(area) });
    expect(crit(assess(office(5000), rules), "COMMERCIAL_SIZE").state).toBe("REVIEW");
    expect(crit(assess(office(180), rules), "COMMERCIAL_SIZE").state).toBe("REVIEW");
    expect(crit(assess(office(180), buildRules({ commercialMinStatus: "CONFIRMED" })), "COMMERCIAL_SIZE").state).toBe("FAIL");
    expect(crit(assess(office(180), buildRules({ commercialMinStatus: "DISABLED" })), "COMMERCIAL_SIZE").state).toBe("PASS");
    expect(crit(assess(office(800), rules), "COMMERCIAL_SIZE").state).toBe("PASS");
  });
});

describe("disposition precedence", () => {
  it("complaint intent wins over everything", () => {
    expect(assess(facts({ ...base, intent: f("complaint"), locality: f({ raw: "Nashik", canonical: "Nashik" }) }), rules).disposition).toBe("COMPLAINT_ESCALATION");
  });

  it("mandatory review beats two confirmed failures", () => {
    const a = assess(
      facts({ projectCategory: f("commercial"), propertyType: f("office"), areaSqft: f(180), engagement: f("advice_only"), scopeSize: f("full_floor"), locality: f({ raw: "Mumbai", canonical: "Mumbai" }) }),
      rules,
    );
    expect(a.failures.length).toBe(2);
    expect(a.disposition).toBe("HUMAN_REVIEW");
    expect(a.precedenceTrace[1]).toMatch(/mandatory review conditions=1/);
  });

  it("two failures with only a non-mandatory review → DECLINED", () => {
    const a = assess(facts({ ...base, engagement: f("advice_only"), locality: f({ raw: "Nashik", canonical: "Nashik" }), completionWeeks: f(9) }), rules);
    expect(a.disposition).toBe("DECLINED");
  });

  it("one failure + a review condition → HUMAN_REVIEW; one failure alone → NOT_QUALIFIED", () => {
    expect(assess(facts({ ...base, locality: f({ raw: "Nashik", canonical: "Nashik" }), completionWeeks: f(9) }), rules).disposition).toBe("HUMAN_REVIEW");
    expect(assess(facts({ ...base, locality: f({ raw: "Nashik", canonical: "Nashik" }) }), rules).disposition).toBe("NOT_QUALIFIED");
  });

  it("no failures + critical unknown → INCOMPLETE; all satisfied → QUALIFIED", () => {
    expect(assess(facts({ ...base, completionWeeks: undefined }), rules).disposition).toBe("INCOMPLETE");
    expect(assess(facts(base), rules).disposition).toBe("QUALIFIED");
  });

  it("decideDisposition records every precedence step it evaluated", () => {
    const a = assess(facts(base), rules);
    expect(a.precedenceTrace).toHaveLength(7);
    const d = decideDisposition(facts(base), a.criteria);
    expect(d.disposition).toBe("QUALIFIED");
  });

  it("is deterministic: same facts + rule version → identical assessment", () => {
    const x = assess(facts(base), rules);
    const y = assess(facts(base), buildRules());
    expect(y).toEqual(x);
    expect(ruleVersion(rules)).toBe(ruleVersion(buildRules()));
    expect(ruleVersion(buildRules({ commercialMinStatus: "CONFIRMED" }))).not.toBe(ruleVersion(rules));
  });

  it("the same conversation always yields the same outcome", () => {
    const a = runScript(scenarioById("P13")!.turns).assessment;
    const b = runScript(scenarioById("P13")!.turns).assessment;
    expect(a).toEqual(b);
  });
});
