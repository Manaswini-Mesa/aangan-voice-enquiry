import { describe, expect, it } from "vitest";
import { extractFromUtterance, type QuestionKey } from "@/core/extraction/rules-extractor";
import { mergeFacts } from "@/core/extraction/merge";
import { NOW, f } from "../helpers";

const x = (text: string, lastQuestion: QuestionKey | null = null, sttConfidence?: number) =>
  extractFromUtterance(text, { lastQuestion, now: NOW, turn: 1, sttConfidence }).facts;

describe("rule-based fact extraction", () => {
  it("captures a rich first utterance", () => {
    const r = x("Hi, I'm Priya. We have a 3BHK in Kothrud — Dahanukar Colony. We want to redo the whole thing — kitchen, living room, both bedrooms. About 1,400 sq ft carpet.");
    expect(r.callerName?.value).toBe("Priya");
    expect(r.bhk?.value).toBe(3);
    expect(r.locality?.value.canonical).toBe("Kothrud");
    expect(r.scopeSize?.value).toBe("full_home");
    expect(r.areaSqft?.value).toBe(1400);
    expect(r.engagement?.value).toBe("design_and_execution");
    expect(r.rooms?.value).toEqual(expect.arrayContaining(["kitchen", "living room", "bedroom"]));
  });

  it("does not treat 'Aangan Studio' as a commercial studio project", () => {
    expect(x("Hello, is this Aangan Studio? I have a 2BHK flat.").projectCategory?.value).toBe("residential");
  });

  it("home office is a room, not a commercial project", () => {
    expect(x("I want to redo my home office and study in Aundh").projectCategory).toBeUndefined();
  });

  it("recognises unsupported commercial types", () => {
    expect(x("I'm opening a restaurant in Koregaon Park").propertyType?.value).toBe("restaurant");
    expect(x("We have a gym of 2500 sq ft").propertyType?.value).toBe("gym");
  });

  it("explicit execution wording beats 'just design'", () => {
    expect(x("just design and fittings with execution").engagement?.value).toBe("design_and_execution");
    expect(x("we only want the design, we have our own contractor").engagement?.value).toBe("design_only");
  });

  it("structural negation vs request", () => {
    expect(x("no structural changes please").structuralWork?.value).toBe("none");
    expect(x("landlord is fine as long as we don't break walls").structuralWork?.value).toBe("none");
    expect(x("we want to remove the wall between kitchen and hall").structuralWork?.value).toBe("required");
  });

  it("timeline phrases are converted to weeks from today (10 Oct 2026)", () => {
    expect(x("We'd like it done by March").completionWeeks?.value).toBeGreaterThan(20);
    expect(x("It must be done within three weeks").completionWeeks?.value).toBe(3);
    expect(x("before Diwali").completionWeeks?.value).toBeLessThan(5);
    expect(x("no rush, we're flexible").timelineFlexible?.value).toBe(true);
    expect(x("March", "timeline").completionWeeks?.value).toBeGreaterThan(20);
  });

  it("site readiness and possession", () => {
    expect(x("I'm getting possession of my flat in about six weeks").siteReadyWeeks?.value).toBe(6);
    expect(x("Possession was last month, completely empty").siteReadyWeeks?.value).toBe(0);
  });

  it("possession timing is not mistaken for a completion deadline", () => {
    expect(x("I'm getting possession of my flat in about six weeks").completionWeeks).toBeUndefined();
  });

  it("budget is parsed only when volunteered with a currency unit", () => {
    expect(x("My budget is 1 to 1.5 lakh maximum for everything").budgetInr?.value).toEqual({ min: 100000, max: 150000 });
    expect(x("Budget: ₹35–40 lakh for the above scope").budgetInr?.value).toEqual({ min: 3500000, max: 4000000 });
    expect(x("It's about 1,400 sq ft").budgetInr).toBeUndefined();
    expect(x("I'd prefer not to mention the budget").budgetDeclined?.value).toBe(true);
  });

  it("authority patterns", () => {
    expect(x("Yes — myself and my husband. He knows we're calling and is happy to go ahead.").authority?.value).toBe("authorized_representative");
    expect(x("I'm the founder").authority?.value).toBe("decision_maker");
    expect(x("I'm just doing initial research for my in-laws, they'll decide").authority?.value).toBe("researching_for_others");
    expect(x("They've asked me to go ahead and book on their behalf").authority?.value).toBe("authorized_representative");
    expect(x("yes", "authority").authority?.value).toBe("decision_maker");
  });

  it("complaint intent requires an existing-project context", () => {
    expect(x("My designer Aryan hasn't replied in five days. This is not acceptable.").intent?.value).toBe("complaint");
    expect(x("My designer Aryan hasn't replied in five days.").existingDesigner?.value).toBe("Aryan");
  });

  it("answers to a direct question are interpreted in context", () => {
    expect(x("Baner", "location").locality?.value.canonical).toBe("Baner");
    expect(x("Sunita Rao", "name").callerName?.value).toBe("Sunita Rao");
    expect(x("about 900", "area").areaSqft?.value).toBe(900);
    expect(x("Yes let's book it", "name").callerName).toBeUndefined();
  });

  it("several places in one breath: the site location is preferred and alternatives recorded", () => {
    const r = x("I live in Mumbai but the flat is in Baner");
    expect(r.locality?.value.canonical).toBe("Baner");
    expect(r.locality?.value.alternatives).toContain("Mumbai");
  });

  it("'Nanded City' (Pune) is not confused with Nanded (another city)", () => {
    expect(x("Our flat is in Nanded City").locality?.value.canonical).toBe("Nanded City");
  });

  it("low STT confidence caps fact confidence and marks it unverified", () => {
    const r = x("The flat is in Nashik", null, 0.4);
    expect(r.locality?.confidence).toBeLessThanOrEqual(0.4);
    expect(r.locality?.validation).toBe("unverified");
  });

  it("empty input yields no facts and the empty signal", () => {
    const r = extractFromUtterance("   ", { lastQuestion: null, now: NOW, turn: 1 });
    expect(r.signals.empty).toBe(true);
    expect(r.facts).toEqual({});
  });
});

describe("fact merging and validation", () => {
  it("a direct answer updates a fact without conflict", () => {
    const r = mergeFacts({ locality: f({ raw: "Baner", canonical: "Baner" }) }, { locality: f({ raw: "Aundh", canonical: "Aundh" }) }, { correction: false, lastQuestion: "location" });
    expect(r.conflicts).toHaveLength(0);
    expect(r.facts.locality?.value.canonical).toBe("Aundh");
  });

  it("an unprompted change to a confident fact is a conflict", () => {
    const r = mergeFacts({ locality: f({ raw: "Baner", canonical: "Baner" }) }, { locality: f({ raw: "Aundh", canonical: "Aundh" }) }, { correction: false, lastQuestion: "timeline" });
    expect(r.conflicts).toHaveLength(1);
    expect(r.facts.locality?.validation).toBe("conflict");
  });

  it("a correction marker replaces the value", () => {
    const r = mergeFacts({ locality: f({ raw: "Baner", canonical: "Baner" }) }, { locality: f({ raw: "Aundh", canonical: "Aundh" }) }, { correction: true, lastQuestion: null });
    expect(r.conflicts).toHaveLength(0);
    expect(r.facts.locality?.value.canonical).toBe("Aundh");
  });

  it("AI inferences never override what the caller said", () => {
    const ai = { value: { raw: "Aundh", canonical: "Aundh" }, source: "ai_inferred" as const, confidence: 0.7 };
    const r = mergeFacts({ locality: f({ raw: "Baner", canonical: "Baner" }) }, { locality: ai }, { correction: false, lastQuestion: null });
    expect(r.facts.locality?.value.canonical).toBe("Baner");
  });

  it("listing rooms after 'full home' keeps the broader scope", () => {
    const r = mergeFacts({ scopeSize: f("full_home") }, { scopeSize: f("multi_room") }, { correction: false, lastQuestion: null });
    expect(r.facts.scopeSize?.value).toBe("full_home");
    expect(r.conflicts).toHaveLength(0);
  });

  it("intent is sticky: a complaint is never downgraded", () => {
    const r = mergeFacts({ intent: f("complaint") }, { intent: f("new_enquiry") }, { correction: false, lastQuestion: null });
    expect(r.facts.intent?.value).toBe("complaint");
  });
});
