import { disconnect, initialState, processTurn, type ConversationState, type TurnOutput } from "@/core/conversation/engine";
import { buildRules, type RuleConfig } from "@/core/rules";
import type { Scenario } from "@/core/scenarios";
import type { EnquiryFacts, Fact } from "@/core/types";

export const NOW = new Date("2026-10-10T06:00:00Z"); // 11:30 IST, Saturday 10 Oct 2026

export function runScript(turns: string[], opts: { rules?: RuleConfig; callerNumber?: string; disconnectAfter?: boolean; confidence?: number[] } = {}) {
  const rules = opts.rules ?? buildRules();
  let state: ConversationState = initialState({ callerNumber: opts.callerNumber });
  const replies: string[] = [];
  let out: TurnOutput | undefined;
  for (let i = 0; i < turns.length; i++) {
    out = processTurn(state, { text: turns[i], now: NOW, confidence: opts.confidence?.[i] }, { rules });
    state = out.state;
    replies.push(out.reply);
    if (out.endCall) break;
  }
  if (opts.disconnectAfter || !out) out = disconnect(state, rules);
  return { state: out.state, replies, out, assessment: out.assessment };
}

export function runScenario(sc: Scenario, rules?: RuleConfig) {
  return runScript(sc.turns, { rules, callerNumber: sc.callerNumber, disconnectAfter: sc.disconnectAfter });
}

/** Builds a caller-stated fact for direct engine tests. */
export function f<T>(value: T, confidence = 0.9): Fact<T> {
  return { value, source: "caller_stated", confidence, validation: "valid" };
}

export function facts(partial: Partial<EnquiryFacts>): EnquiryFacts {
  return { intent: f("new_enquiry"), ...partial };
}
