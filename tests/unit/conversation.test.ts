import { describe, expect, it } from "vitest";
import { disconnect, greeting, initialState, processTurn } from "@/core/conversation/engine";
import { buildRules } from "@/core/rules";
import { NOW, runScript } from "../helpers";

const rules = buildRules();

describe("conversation engine", () => {
  it("greets warmly and discloses it is a virtual assistant", () => {
    expect(greeting(initialState())).toMatch(/virtual assistant/);
    expect(greeting(initialState({ recordingNotice: true }))).toMatch(/may be recorded/);
  });

  it("asks one focused question at a time and never repeats a known fact", () => {
    const r = runScript(["Hi, I'm Asha. 3BHK in Kothrud, full home with execution, done by March. I'm the owner."], { callerNumber: "+919800000001" });
    const reply = r.replies[0];
    expect((reply.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(reply).not.toMatch(/locality|which area/i);
    expect(reply).not.toMatch(/when would you/i);
    expect(reply).toMatch(/consultation/i);
  });

  it("understands answers given out of order", () => {
    const r = runScript(["By end of February please", "It's in Aundh", "A complete redesign of the master bedroom with execution", "Yes it's my own flat", "Meera"]);
    expect(r.state.facts.completionWeeks).toBeDefined();
    expect(r.state.facts.locality?.value.canonical).toBe("Aundh");
    expect(r.state.facts.scopeSize?.value).toBe("single_room");
    expect(r.assessment.disposition).toBe("QUALIFIED");
  });

  it("transitions stages: greeting → clarification → booking → qualified → ends politely", () => {
    let s = initialState({ callerNumber: "+919800000001" });
    expect(s.stage).toBe("greeting");
    let out = processTurn(s, { text: "I'm Asha, I want a full home redesign with execution for my 3BHK", now: NOW }, { rules });
    expect(out.state.stage).toBe("location_clarification");
    s = out.state;
    out = processTurn(s, { text: "Baner", now: NOW }, { rules });
    expect(out.state.stage).toBe("timeline_clarification");
    s = out.state;
    out = processTurn(s, { text: "By April", now: NOW }, { rules });
    expect(out.state.stage).toBe("authority_clarification");
    s = out.state;
    out = processTurn(s, { text: "Yes I'm the owner", now: NOW }, { rules });
    expect(out.state.stage).toBe("qualified");
    expect(out.state.lastQuestion).toBe("consultation_offer");
    s = out.state;
    out = processTurn(s, { text: "Yes please", now: NOW }, { rules });
    expect(out.state.lastQuestion).toBe("consultation_time");
    s = out.state;
    out = processTurn(s, { text: "Saturday morning", now: NOW }, { rules });
    expect(out.reply).toMatch(/isn't confirmed yet/);
    s = out.state;
    out = processTurn(s, { text: "No, that's all", now: NOW }, { rules });
    expect(out.endCall).toBe(true);
    expect(out.events.some((e) => e.type === "call_ended")).toBe(true);
  });

  it("never claims a confirmed booking or a completed qualification to the caller", () => {
    const r = runScript(["I'm Asha, full home redesign with execution for my 3BHK in Baner by April, I'm the owner", "Yes please book", "Monday 10am", "that's all"]);
    for (const reply of r.replies) {
      expect(reply).not.toMatch(/\b(is|are) (now )?confirmed\b|you('re| are) qualified|booked for/i);
    }
  });

  it("handles silence and ends after repeated silence, preserving facts", () => {
    const r = runScript(["I have a 2BHK in Wakad", "", "", ""]);
    expect(r.replies[1]).toMatch(/didn't catch that/);
    expect(r.out.endCall).toBe(true);
    expect(r.state.endReason).toBe("silence_timeout");
    expect(r.state.facts.locality?.value.canonical).toBe("Wakad");
  });

  it("asks for confirmation when a decisive answer is heard with low confidence", () => {
    const r = runScript(["It's in Nashik"], { confidence: [0.4] });
    expect(r.replies[0]).toMatch(/line isn't very clear — did you say Nashik/);
    expect(r.state.lastQuestion).toBe("confirm_value");
    expect(r.assessment.disposition).not.toBe("NOT_QUALIFIED");
  });

  it("confirmed low-confidence value becomes decisive", () => {
    const r = runScript(["It's in Nashik", "Yes"], { confidence: [0.4, 1] });
    expect(r.state.facts.locality?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.assessment.criteria.find((c) => c.id === "LOCATION")?.state).toBe("FAIL");
  });

  it("detects a conflicting answer and asks the caller to confirm", () => {
    const r = runScript(["The flat is in Baner, full home with execution", "By April", "Oh and the flat is in Aundh"]);
    expect(r.replies[2]).toMatch(/Just to make sure I have this right/);
  });

  it("caller asking for a human gets an honest callback promise (no transfer claimed)", () => {
    const r = runScript(["Can I speak to a real person?"]);
    expect(r.replies[0]).toMatch(/not able to transfer/);
    expect(r.out.events.some((e) => e.type === "human_callback_requested")).toBe(true);
  });

  it("disconnect mid-call marks the conversation disconnected and incomplete", () => {
    const r = runScript(["Hi, 3BHK in Baner, kitchen and wardrobes with execution"], { disconnectAfter: true });
    expect(r.state.stage).toBe("disconnected");
    expect(r.assessment.disposition).toBe("INCOMPLETE");
    const again = disconnect(r.state, rules);
    expect(again.events).toHaveLength(0); // idempotent
  });

  it("does not ask for budget", () => {
    const r = runScript(["I'm Asha, full home redesign with execution for my 3BHK in Baner by April", "I'm the owner"]);
    for (const reply of r.replies) expect(reply).not.toMatch(/budget/i);
  });

  it("existing client (non-complaint) is routed to the project team, not qualified", () => {
    const r = runScript(["Hi, I'm an existing client, my designer is Kunal — I want to change the tiles we picked", "Nisha", "Viman Nagar", "That's all"]);
    expect(r.assessment.disposition).toBe("EXISTING_CLIENT_REQUEST");
  });

  it("a call that ended keeps returning a closing line", () => {
    const r = runScript(["bye"]);
    expect(r.out.endCall).toBe(true);
    const again = processTurn(r.state, { text: "hello?", now: NOW }, { rules });
    expect(again.endCall).toBe(true);
  });
});
