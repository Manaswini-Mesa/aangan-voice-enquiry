import { after, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assessState, type ConversationState } from "@/core/conversation/engine";
import { getCurrentUser } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { config } from "@/server/env";
import { rateLimit } from "@/server/rate-limit";
import { afterCallWork, endCall, ensureCall, handleCallerTurn } from "@/server/services/calls";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Simulated calls: same engine, persistence and workflows as live calls, but every record is
// flagged is_simulated and shown as "Simulated". Requires a signed-in admin/manager.

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), callerNumber: z.string().max(20).optional() }),
  z.object({ action: z.literal("turn"), sessionId: z.string().min(1).max(100), text: z.string().max(2000), confidence: z.number().min(0).max(1).optional() }),
  z.object({ action: z.literal("end"), sessionId: z.string().min(1).max(100) }),
]);

async function snapshot(sessionId: string) {
  const db = await getDb();
  const call = (await db.query<{ id: string; lead_id: string; conversation_state: ConversationState; status: string }>(
    `SELECT id, lead_id, conversation_state, status FROM calls WHERE provider = 'simulator' AND provider_call_id = $1`,
    [sessionId],
  ))[0];
  if (!call) return null;
  const lead = (await db.query<{ ref: string; status: string }>(`SELECT ref, status FROM leads WHERE id = $1`, [call.lead_id]))[0];
  const st = call.conversation_state;
  const a = assessState(st, config().rules);
  return {
    leadId: call.lead_id,
    leadRef: lead.ref,
    leadStatus: lead.status,
    callStatus: call.status,
    stage: st.stage,
    lastQuestion: st.lastQuestion,
    pricingQuestions: st.pricingQuestions,
    facts: Object.entries(st.facts).map(([key, f]) => ({ key, value: (f as { value: unknown }).value, source: (f as { source: string }).source, confidence: (f as { confidence: number }).confidence, validation: (f as { validation?: string }).validation })),
    assessment: { disposition: a.disposition, ruleVersion: a.ruleVersion, criteria: a.criteria.map((c) => ({ id: c.id, label: c.label, state: c.state, applicable: c.applicable, reasons: c.reasons, ruleCode: c.ruleCode })), reviewReasons: a.reviewReasons, missingCritical: a.missingCritical, trace: a.precedenceTrace },
  };
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(user.role, "simulator:use")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!rateLimit(`sim:${user.id}`, 240, 60_000).ok) return NextResponse.json({ error: "rate limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const b = parsed.data;
  const db = await getDb();
  try {
    if (b.action === "start") {
      const sessionId = `sim-${randomUUID()}`;
      const r = await ensureCall(db, { provider: "simulator", providerCallId: sessionId, mode: "simulated" }, { callerNumber: b.callerNumber || undefined, at: new Date() });
      return NextResponse.json({ sessionId, reply: r.greeting, endCall: false, snapshot: await snapshot(sessionId) });
    }
    if (b.action === "turn") {
      const r = await handleCallerTurn(db, { provider: "simulator", providerCallId: b.sessionId, mode: "simulated", text: b.text, confidence: b.confidence });
      if (r.endCall) after(() => afterCallWork(db, r.callId, r.pendingNotifications));
      return NextResponse.json({ reply: r.reply, endCall: r.endCall, snapshot: await snapshot(b.sessionId) });
    }
    const r = await endCall(db, { provider: "simulator", providerCallId: b.sessionId, mode: "simulated" }, { reason: "simulated_disconnect" });
    after(() => afterCallWork(db, r.callId, r.pendingNotifications));
    return NextResponse.json({ ended: r.found, snapshot: await snapshot(b.sessionId) });
  } catch (err) {
    return NextResponse.json({ error: `Simulator error: ${(err as Error).message.slice(0, 200)}` }, { status: 500 });
  }
}
