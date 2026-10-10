// Dev helper: prints a full simulated conversation for a scenario id. Usage: npx tsx scripts/run-scenario.ts P01
import { initialState, processTurn, disconnect, greeting } from "../src/core/conversation/engine";
import { buildRules } from "../src/core/rules";
import { SCENARIOS } from "../src/core/scenarios";

const rules = buildRules();
const now = new Date("2026-10-10T06:00:00Z");
const ids = process.argv.slice(2);
for (const sc of SCENARIOS.filter((s) => !ids.length || ids.includes(s.id))) {
  let state = initialState({ callerNumber: sc.callerNumber });
  console.log(`\n=== ${sc.id} ${sc.title} (expect ${sc.expected})`);
  console.log(`AGENT: ${greeting(state)}`);
  let out;
  for (const t of sc.turns) {
    out = processTurn(state, { text: t, now }, { rules });
    state = out.state;
    console.log(`CALLER: ${t}\nAGENT: ${out.reply}${out.endCall ? "  [END]" : ""}`);
    if (out.endCall) break;
  }
  if (sc.disconnectAfter) out = disconnect(state, rules);
  const a = out!.assessment;
  console.log(`--> ${a.disposition} ${a.disposition === sc.expected ? "OK" : "MISMATCH"} | ` + a.criteria.map((c) => `${c.id}:${c.state}`).join(" "));
  if (a.disposition !== sc.expected) console.log(JSON.stringify(state.facts, null, 1).slice(0, 3000), a.criteria.map(c=>c.reasons));
}
