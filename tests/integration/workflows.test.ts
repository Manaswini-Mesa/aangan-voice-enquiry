import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Live-mode configuration (no real credentials): database and providers are replaced by
// an in-memory PostgreSQL (PGlite) and test doubles.
process.env.APP_MODE = "live";
process.env.AUTH_SECRET = "t".repeat(40);
process.env.NOTIFY_HANDOFF_TO = "designers@example.test";
process.env.NOTIFY_REVIEW_TO = "review@example.test";
process.env.NOTIFY_COMPLAINTS_TO = "seniors@example.test";
process.env.APP_BASE_URL = "https://aangan.example.test";
delete process.env.RESEND_API_KEY;
delete process.env.DATABASE_URL;

const { createMemoryDb, setDbForTests, getDb, DatabaseUnavailableError } = await import("@/server/db/client");
const { resetConfigForTests } = await import("@/server/env");
const { setEmailProviderForTests } = await import("@/server/providers/email");
const { setAiProviderForTests } = await import("@/server/providers/ai");
const calls = await import("@/server/services/calls");
const { processVaaniWebhook, finalizeStaleCalls } = await import("@/server/services/webhooks");
const { dispatchNotification } = await import("@/server/services/notifications");
const wf = await import("@/server/services/workflow");
const { listLeads, getLeadDetail } = await import("@/server/repo/queries");
const { createUser } = await import("@/server/repo/users");
const { seedDemoData } = await import("@/server/bootstrap");
const { getOverview } = await import("@/server/services/metrics");
const { APPROVED_PRICING_RESPONSE } = await import("@/core/pricing/policy");

type Db = Awaited<ReturnType<typeof createMemoryDb>>;
type EmailMsg = { to: string[]; subject: string; idempotencyKey: string };

class FakeEmail {
  readonly name = "fake";
  readonly live = true;
  sent: EmailMsg[] = [];
  mode: "ok" | "fail" = "ok";
  async send(m: EmailMsg) {
    if (this.mode === "fail") return { status: "failed" as const, error: "Resend 503: unavailable", retryable: true };
    this.sent.push(m);
    return { status: "sent" as const, providerMessageId: `msg_${this.sent.length}` };
  }
  async verify() {
    return { ok: true, detail: "fake" };
  }
}

let db: Db;
let email: FakeEmail;
let seq = 0;
const live = () => ({ provider: "vaani", providerCallId: `call-${++seq}-${Date.now()}`, mode: "live" as const });
const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p))[0];
const count = async (sql: string, p: unknown[] = []) => Number((await db.query<{ n: string }>(sql, p))[0].n);

async function talk(key: ReturnType<typeof live>, turns: string[], callerNumber = `+9198${String(Date.now()).slice(-8)}`) {
  let last: Awaited<ReturnType<typeof calls.handleCallerTurn>> | undefined;
  let i = 0;
  for (const text of turns) {
    last = await calls.handleCallerTurn(db, { ...key, text, callerNumber, turnKey: `t${i++}` });
    if (last.endCall) {
      await calls.afterCallWork(db, last.callId, last.pendingNotifications);
      break;
    }
  }
  return last!;
}

const QUALIFIED = [
  "Hi, I'm Asha Kulkarni. We have a 3BHK in Kothrud and want a full home redesign with execution.",
  "By end of March, no rush.",
  "Yes, it's our own flat and I decide.",
  "Yes please, book a consultation.",
  "Saturday morning.",
  "No, that's all.",
];

beforeAll(async () => {
  resetConfigForTests();
  db = await createMemoryDb();
  setDbForTests(db);
});
afterAll(() => {
  setDbForTests(undefined);
  setEmailProviderForTests(undefined);
  setAiProviderForTests(undefined);
});
beforeEach(() => {
  email = new FakeEmail();
  setEmailProviderForTests(email);
  setAiProviderForTests(undefined);
});

describe("lead and call persistence", () => {
  it("a qualified call creates lead, call, transcript, facts, assessment, handoff, appointment request and a sent handoff email", async () => {
    const key = live();
    const r = await talk(key, QUALIFIED);
    expect(r.endCall).toBe(true);
    expect(r.disposition).toBe("QUALIFIED");
    const lead = await one<{ status: string; locality: string; caller_name: string; first_response_at: string | null }>(`SELECT * FROM leads WHERE id = $1`, [r.leadId]);
    expect(lead.status).toBe("qualified");
    expect(lead.locality).toBe("Kothrud");
    expect(lead.caller_name).toBe("Asha Kulkarni");
    expect(lead.first_response_at).not.toBeNull();
    expect(await count(`SELECT count(*)::text n FROM transcript_segments WHERE call_id = $1`, [r.callId])).toBe(1 + QUALIFIED.length * 2);
    expect(await count(`SELECT count(*)::text n FROM facts WHERE lead_id = $1 AND NOT superseded`, [r.leadId])).toBeGreaterThan(8);
    expect(await count(`SELECT count(*)::text n FROM assessments WHERE lead_id = $1`, [r.leadId])).toBeGreaterThan(1);
    const handoff = await one<{ status: string; brief: { leadRef: string; caller: { phone: string } } }>(`SELECT * FROM handoffs WHERE lead_id = $1`, [r.leadId]);
    expect(handoff.status).toBe("pending_assignment");
    expect(handoff.brief.leadRef).toBe(r.leadRef);
    const appt = await one<{ status: string; preferred_text: string }>(`SELECT * FROM appointments WHERE lead_id = $1`, [r.leadId]);
    expect(appt.status).toBe("pending_confirmation");
    expect(appt.preferred_text).toMatch(/Saturday/);
    const n = await one<{ status: string; provider_message_id: string }>(`SELECT * FROM notifications WHERE lead_id = $1 AND kind = 'handoff'`, [r.leadId]);
    expect(n.status).toBe("sent");
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].subject).toContain(r.leadRef);
  });

  it("lead persists and is retrievable with full detail (survives a fresh query = page refresh)", async () => {
    const r = await talk(live(), QUALIFIED);
    const admin = { id: "00000000-0000-0000-0000-000000000000", name: "T", email: "t@x", role: "admin" as const, isDemo: false };
    const detail = await getLeadDetail(db, admin, r.leadId);
    expect(detail?.lead.ref).toBe(r.leadRef);
    expect(detail?.segments.length).toBeGreaterThan(5);
    const list = await listLeads(db, admin, { q: r.leadRef.toLowerCase() });
    expect(list.rows.map((x) => x.id)).toContain(r.leadId);
  });

  it("a partial call that disconnects is saved as incomplete with a callback follow-up", async () => {
    const key = live();
    await calls.handleCallerTurn(db, { ...key, text: "Hi, I'm Ritu from Pimple Saudagar. 3BHK, kitchen and wardrobes with execution.", callerNumber: "+919811111111" });
    const end = await calls.endCall(db, key, { reason: "caller_hung_up" });
    await calls.afterCallWork(db, end.callId, end.pendingNotifications);
    const call = await one<{ status: string; lead_id: string }>(`SELECT * FROM calls WHERE provider_call_id = $1`, [key.providerCallId]);
    expect(call.status).toBe("disconnected");
    const lead = await one<{ status: string; next_action: string }>(`SELECT * FROM leads WHERE id = $1`, [call.lead_id]);
    expect(lead.status).toBe("incomplete");
    expect(lead.next_action).toMatch(/timeline/i);
    expect(await count(`SELECT count(*)::text n FROM follow_ups WHERE lead_id = $1 AND kind = 'callback_incomplete' AND status = 'open'`, [call.lead_id])).toBe(1);
    // ending again is idempotent
    const again = await calls.endCall(db, key, {});
    expect(again.pendingNotifications).toEqual([]);
    expect(await count(`SELECT count(*)::text n FROM follow_ups WHERE lead_id = $1`, [call.lead_id])).toBe(1);
  });

  it("a repeat caller with an unfinished enquiry is linked and not asked known facts again", async () => {
    const number = "+919822222222";
    const k1 = live();
    await calls.handleCallerTurn(db, { ...k1, text: "Hi, I'm Ritu. 3BHK in Pimple Saudagar, kitchen and wardrobes with execution.", callerNumber: number });
    await calls.endCall(db, k1, { reason: "dropped" });
    const k2 = live();
    const r = await calls.handleCallerTurn(db, { ...k2, text: "Hi, I called just now and got cut off.", callerNumber: number });
    const leadIds = await db.query<{ lead_id: string }>(`SELECT lead_id FROM calls WHERE provider_call_id IN ($1,$2)`, [k1.providerCallId, k2.providerCallId]);
    expect(new Set(leadIds.map((l) => l.lead_id)).size).toBe(1);
    expect(r.reply).toMatch(/complete/i); // asks timeline next, not location again
    expect(r.reply).not.toMatch(/locality/i);
  });

  it("duplicate provider turn (same response id) returns the same reply without reprocessing", async () => {
    const key = live();
    const a = await calls.handleCallerTurn(db, { ...key, text: "I have a 2BHK in Wakad", turnKey: "r1", callerNumber: "+919833333333" });
    const b = await calls.handleCallerTurn(db, { ...key, text: "I have a 2BHK in Wakad", turnKey: "r1", callerNumber: "+919833333333" });
    expect(b.reply).toBe(a.reply);
    expect(b.duplicate).toBe(true);
    expect(await count(`SELECT count(*)::text n FROM transcript_segments WHERE call_id = $1`, [a.callId])).toBe(3);
  });

  it("assessments are appended only when facts change, and keep their rule version", async () => {
    const key = live();
    const r1 = await calls.handleCallerTurn(db, { ...key, text: "2BHK in Baner, full home with execution", callerNumber: "+919844444444" });
    const n1 = await count(`SELECT count(*)::text n FROM assessments WHERE lead_id = $1`, [r1.leadId]);
    await calls.handleCallerTurn(db, { ...key, text: "hmm" });
    const n2 = await count(`SELECT count(*)::text n FROM assessments WHERE lead_id = $1`, [r1.leadId]);
    await calls.handleCallerTurn(db, { ...key, text: "By end of March" });
    const n3 = await count(`SELECT count(*)::text n FROM assessments WHERE lead_id = $1`, [r1.leadId]);
    expect(n2).toBe(n1);
    expect(n3).toBe(n1 + 1);
    const rv = await one<{ rule_version: string }>(`SELECT rule_version FROM assessments WHERE lead_id = $1 LIMIT 1`, [r1.leadId]);
    expect(rv.rule_version).toMatch(/^2026\.10\.1\+/);
    expect(await count(`SELECT count(*)::text n FROM rule_versions WHERE version = $1`, [rv.rule_version])).toBe(1);
  });

  it("repeated pricing questions on a live call never return a price", async () => {
    const key = live();
    const a = await calls.handleCallerTurn(db, { ...key, text: "How much per sq ft?", callerNumber: "+919855555555" });
    const b = await calls.handleCallerTurn(db, { ...key, text: "Just give me a ballpark" });
    expect(a.reply).toBe(APPROVED_PRICING_RESPONSE);
    expect(b.reply).toContain(APPROVED_PRICING_RESPONSE);
  });
});

describe("webhooks", () => {
  it("duplicate webhook deliveries never create duplicate records", async () => {
    const payload = { event: "call_started", room_name: "inbound-dup-1", status: "active", phone_number: "+919866666666", timestamp: "2026-10-10T10:00:00Z" };
    const a = await processVaaniWebhook(db, payload);
    const b = await processVaaniWebhook(db, payload);
    expect(a.status).toBe("processed");
    expect(b.status).toBe("duplicate");
    expect(await count(`SELECT count(*)::text n FROM calls WHERE provider_call_id = 'inbound-dup-1'`)).toBe(1);
    expect(await count(`SELECT count(*)::text n FROM webhook_events WHERE provider_call_id = 'inbound-dup-1'`)).toBe(1);
  });

  it("post-call path: provider transcript is qualified by the same rules when BYOL did not drive the call", async () => {
    const id = "inbound-replay-1";
    await processVaaniWebhook(db, { event: "call_started", room_name: id, phone_number: "+919877777777", timestamp: "t1" });
    await processVaaniWebhook(db, { event: "call_ended", room_name: id, call_duration: 95, end_reason: "Call ended", timestamp: "t2" });
    const post = await processVaaniWebhook(db, {
      event: "call_postprocessing",
      call_id: id,
      timestamp: "t3",
      data: {
        room_name: id,
        call_duration: 95000,
        summary: "Caller wants a restaurant in Mumbai.",
        transcript: "[10:00:01] AGENT: Hello\n\n[10:00:05] USER: I'm opening a restaurant in Mumbai and want interiors.\n\n[10:00:10] AGENT: I see.",
        recording_url: "https://example.test/rec",
      },
    });
    expect(post.status).toBe("processed");
    const call = await one<{ lead_id: string; provider_summary: string; recording_ref: string | null; duration_sec: string }>(`SELECT * FROM calls WHERE provider_call_id = $1`, [id]);
    expect(call.provider_summary).toMatch(/restaurant/);
    expect(call.recording_ref).toBeNull(); // recording disabled by default
    const lead = await one<{ status: string }>(`SELECT status FROM leads WHERE id = $1`, [call.lead_id]);
    expect(lead.status).toBe("declined");
    const usage = await one<{ cost_type: string; quantity: string }>(`SELECT * FROM usage_events WHERE call_id = (SELECT id FROM calls WHERE provider_call_id = $1)`, [id]);
    expect(usage.cost_type).toBe("unavailable");
    expect(Number(usage.quantity)).toBeCloseTo(1.58, 1);
  });

  it("unknown or id-less events are ignored, not failed", async () => {
    expect((await processVaaniWebhook(db, { event: "something_new", room_name: "x" })).status).toBe("ignored");
    expect((await processVaaniWebhook(db, { foo: 1 })).status).toBe("ignored");
  });

  it("stale-call sweep finalizes calls that never ended cleanly", async () => {
    const key = live();
    const r = await calls.handleCallerTurn(db, { ...key, text: "2BHK in Baner", callerNumber: "+919888888888" });
    await db.query(`UPDATE calls SET started_at = now() - interval '3 hours' WHERE id = $1`, [r.callId]);
    const s = await finalizeStaleCalls(db);
    expect(s.finalized).toBeGreaterThanOrEqual(1);
    const c = await one<{ status: string; finalized_at: string | null }>(`SELECT * FROM calls WHERE id = $1`, [r.callId]);
    expect(c.status).toBe("disconnected");
    expect(c.finalized_at).not.toBeNull();
  });
});

describe("notifications: failure, visibility and retry", () => {
  it("a failed email never erases the handoff; it stays visible and a retry sends exactly once", async () => {
    email.mode = "fail";
    const r = await talk(live(), QUALIFIED);
    const n = await one<{ id: string; status: string; last_error: string; idempotency_key: string }>(`SELECT * FROM notifications WHERE lead_id = $1 AND kind = 'handoff'`, [r.leadId]);
    expect(n.status).toBe("failed");
    expect(n.last_error).toMatch(/503/);
    expect(await count(`SELECT count(*)::text n FROM handoffs WHERE lead_id = $1`, [r.leadId])).toBe(1);
    expect(await count(`SELECT count(*)::text n FROM ops_events WHERE code = 'EMAIL_FAILED' AND lead_id = $1`, [r.leadId])).toBe(1);

    email.mode = "ok";
    const manager = await createUser(db, { email: `m${Date.now()}@x.test`, name: "Manager", role: "manager", password: "pw-123456789" });
    const staff = { id: manager.id, name: manager.name, role: "manager" as const };
    const after = await wf.retryNotification(db, staff, n.id);
    expect(after?.status).toBe("sent");
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].idempotencyKey).toBe(n.idempotency_key);
    await expect(wf.retryNotification(db, staff, n.id)).rejects.toThrow(/Already delivered/);
    await dispatchNotification(db, n.id);
    expect(email.sent).toHaveLength(1); // never sent twice
  });

  it("live mode without email credentials records 'not_configured' (never 'sent')", async () => {
    setEmailProviderForTests(undefined); // real factory → no RESEND_API_KEY in live mode
    const r = await talk(live(), QUALIFIED);
    const n = await one<{ status: string }>(`SELECT * FROM notifications WHERE lead_id = $1`, [r.leadId]);
    expect(n.status).toBe("not_configured");
  });

  it("simulated calls never email real inboxes", async () => {
    const key = { provider: "simulator", providerCallId: `sim-${Date.now()}`, mode: "simulated" as const };
    const r = await talk(key as never, QUALIFIED);
    const n = await one<{ status: string }>(`SELECT * FROM notifications WHERE lead_id = $1`, [r.leadId]);
    expect(n.status).toBe("simulated");
    expect(email.sent).toHaveLength(0);
  });
});

describe("complaints, review and appointments", () => {
  it("an existing-client complaint is escalated separately and is not a lead handoff", async () => {
    const r = await talk(live(), [
      "My project has been going for three months and my designer Aryan hasn't replied in five days. This is not acceptable.",
      "Sheetal Deshpande.",
      "Viman Nagar 2BHK.",
      "No, that's all.",
    ]);
    expect(r.disposition).toBe("COMPLAINT_ESCALATION");
    const c = await one<{ status: string; designer_name: string; summary: string }>(`SELECT * FROM complaints WHERE lead_id = $1`, [r.leadId]);
    expect(c.status).toBe("open");
    expect(c.designer_name).toBe("Aryan");
    expect(await count(`SELECT count(*)::text n FROM handoffs WHERE lead_id = $1`, [r.leadId])).toBe(0);
    const n = await one<{ kind: string; status: string; recipients: string[] }>(`SELECT * FROM notifications WHERE lead_id = $1`, [r.leadId]);
    expect(n.kind).toBe("complaint");
    expect(n.recipients).toEqual(["seniors@example.test"]);
    expect(await one<{ status: string }>(`SELECT status FROM leads WHERE id = $1`, [r.leadId])).toEqual({ status: "complaint" });
  });

  it("human review: the original automated assessment is preserved and the override is audited", async () => {
    const r = await talk(live(), ["Hi, I'm Smita. 2BHK in Undri, full home with execution.", "We need it complete in about 9 weeks.", "I'm the owner.", "That's all."]);
    expect(r.disposition).toBe("HUMAN_REVIEW");
    const u = await createUser(db, { email: `r${Date.now()}@x.test`, name: "Reviewer", role: "manager", password: "pw-123456789" });
    await wf.recordReviewDecision(db, { id: u.id, name: u.name, role: "manager" }, r.leadId, "qualify", "Designer confirmed 9 weeks is feasible for this scope.");
    const kinds = (await db.query<{ kind: string; disposition: string }>(`SELECT kind, disposition FROM assessments WHERE lead_id = $1 ORDER BY created_at`, [r.leadId])).map((a) => `${a.kind}:${a.disposition}`);
    expect(kinds.some((k) => k.startsWith("automated:HUMAN_REVIEW"))).toBe(true);
    expect(kinds.at(-1)).toBe("human_override:QUALIFIED");
    expect(await count(`SELECT count(*)::text n FROM audit_log WHERE lead_id = $1 AND action = 'review.decided'`, [r.leadId])).toBe(1);
    expect(await count(`SELECT count(*)::text n FROM handoffs WHERE lead_id = $1`, [r.leadId])).toBe(1);
    await expect(wf.recordReviewDecision(db, { id: u.id, name: u.name, role: "manager" }, r.leadId, "qualify", "")).rejects.toThrow(/rationale/);
  });

  it("appointment confirmation requires an authorised staff member; preference alone is never 'confirmed'", async () => {
    const r = await talk(live(), QUALIFIED);
    const designer = await createUser(db, { email: `d${Date.now()}@x.test`, name: "Designer", role: "designer", password: "pw-123456789" });
    const ds = { id: designer.id, name: designer.name, role: "designer" as const };
    await expect(wf.updateAppointment(db, ds, r.leadId, "confirmed", "")).rejects.toThrow(/not found or not accessible/);
    const mgr = await createUser(db, { email: `mm${Date.now()}@x.test`, name: "Mgr", role: "manager", password: "pw-123456789" });
    await wf.assignDesigner(db, { id: mgr.id, name: mgr.name, role: "manager" }, r.leadId, designer.id);
    await wf.updateAppointment(db, ds, r.leadId, "confirmed", "Called client, Sat 11am");
    const a = await one<{ status: string; confirmed_by: string }>(`SELECT * FROM appointments WHERE lead_id = $1`, [r.leadId]);
    expect(a.status).toBe("confirmed");
    expect(a.confirmed_by).toBe(designer.id);
    await expect(wf.updateAppointment(db, ds, r.leadId, "rejected", "")).rejects.toThrow(/Cannot move/);
  });
});

describe("authorisation", () => {
  it("designers only see leads assigned to them; protected actions are refused", async () => {
    const r = await talk(live(), QUALIFIED);
    const d = await createUser(db, { email: `dd${Date.now()}@x.test`, name: "D2", role: "designer", password: "pw-123456789" });
    const user = { id: d.id, name: d.name, email: d.email, role: "designer" as const, isDemo: false };
    expect(await getLeadDetail(db, user, r.leadId)).toBeNull();
    const list = await listLeads(db, user, {});
    expect(list.rows.every((l) => l.assigned_designer_id === d.id)).toBe(true);
    await expect(wf.recordReviewDecision(db, user, r.leadId, "decline", "not allowed")).rejects.toThrow(/permission/);
    await expect(wf.assignDesigner(db, user, r.leadId, d.id)).rejects.toThrow(/permission/);
    await expect(wf.retryNotification(db, user, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/permission/);
  });
});

describe("provider and database failures", () => {
  it("AI provider failure falls back to rule-based extraction and is logged", async () => {
    setAiProviderForTests({
      name: "broken",
      live: true,
      extractFacts: async () => {
        throw new Error("timeout");
      },
      summarize: async () => {
        throw new Error("timeout");
      },
      verify: async () => ({ ok: false, detail: "x" }),
    });
    const r = await talk(live(), QUALIFIED);
    expect(r.disposition).toBe("QUALIFIED");
    expect(await count(`SELECT count(*)::text n FROM ops_events WHERE code = 'EXTRACTION_FALLBACK' AND lead_id = $1`, [r.leadId])).toBeGreaterThan(0);
    expect(await count(`SELECT count(*)::text n FROM ops_events WHERE code = 'SUMMARY_FALLBACK'`)).toBeGreaterThan(0);
    const call = await one<{ summary_source: string }>(`SELECT summary_source FROM calls WHERE id = $1`, [r.callId]);
    expect(call.summary_source).toBe("deterministic");
  });

  it("live mode with no DATABASE_URL refuses to run (no silent in-memory fallback)", async () => {
    setDbForTests(undefined);
    await expect(getDb()).rejects.toBeInstanceOf(DatabaseUnavailableError);
    setDbForTests(db);
  });

  it("a database failure mid-turn rolls back the whole turn (no half-written records)", async () => {
    const key = live();
    const first = await calls.handleCallerTurn(db, { ...key, text: "2BHK in Baner", callerNumber: "+919899999999" });
    const before = await count(`SELECT count(*)::text n FROM transcript_segments WHERE call_id = $1`, [first.callId]);
    const failing = {
      ...db,
      kind: db.kind,
      query: db.query.bind(db),
      tx: <T,>(fn: (t: Db) => Promise<T>) =>
        db.tx((t) =>
          fn({
            ...t,
            kind: t.kind,
            tx: t.tx.bind(t),
            query: (sql: string, p?: unknown[]) => {
              if (/^\s*INSERT INTO facts/.test(sql)) throw new Error("simulated database failure");
              return t.query(sql, p);
            },
          } as Db),
        ),
    } as Db;
    await expect(calls.handleCallerTurn(failing, { ...key, text: "By end of March" })).rejects.toThrow(/simulated database failure/);
    expect(await count(`SELECT count(*)::text n FROM transcript_segments WHERE call_id = $1`, [first.callId])).toBe(before);
  });
});

describe("demo seed and metrics", () => {
  it("seeding runs every scenario through the real engine and metrics come from stored records", async () => {
    const fresh = await createMemoryDb();
    const n = await seedDemoData(fresh);
    expect(n).toBeGreaterThanOrEqual(18);
    const statuses = await fresh.query<{ status: string; n: string }>(`SELECT status, count(*)::text n FROM leads GROUP BY status`);
    const map = Object.fromEntries(statuses.map((s) => [s.status, Number(s.n)]));
    expect(map.qualified).toBeGreaterThan(0);
    expect(map.review).toBeGreaterThan(0);
    expect(map.complaint).toBe(1);
    expect(await fresh.query(`SELECT 1 FROM leads WHERE NOT is_simulated`)).toHaveLength(0);
    expect((await fresh.query<{ n: string }>(`SELECT count(*)::text n FROM notifications WHERE status = 'failed'`))[0].n).toBe("1");
    const o = await getOverview(fresh, { from: new Date(0), to: new Date(Date.now() + 1000), includeSimulated: true });
    expect(o.total).toBe(n);
    expect(o.complaints).toBe(1);
    const liveOnly = await getOverview(fresh, { from: new Date(0), to: new Date(Date.now() + 1000), includeSimulated: false });
    expect(liveOnly.total).toBe(0); // honest zero: no real data
    expect(await seedDemoData(fresh)).toBe(0); // idempotent
  });
});
