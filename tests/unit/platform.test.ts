import { describe, expect, it } from "vitest";
import { canTransition, validateTransition } from "@/core/appointments";
import { costSummary, responseStats } from "@/core/metrics";
import { isWithinBusinessHours, istDate, nextBusinessTime, weeksUntilEndOfMonth, weeksUntilFestival } from "@/core/time";
import { can, canViewLead } from "@/server/auth/permissions";
import { signSession, verifySession } from "@/server/auth/session-token";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { safeEqual } from "@/server/rate-limit";
import {
  byolResponseFrame,
  latestCallerText,
  normalizeVaaniWebhook,
  parseByolMessage,
  parseVaaniTranscript,
  webhookEventKey,
} from "@/server/providers/voice/vaani";
import { NOW } from "../helpers";

describe("time & business hours (IST)", () => {
  it("business hours are 10:00–19:00 IST", () => {
    expect(isWithinBusinessHours(istDate(2026, 9, 12, 10, 0))).toBe(true); // Mon 10:00
    expect(isWithinBusinessHours(istDate(2026, 9, 12, 18, 59))).toBe(true);
    expect(isWithinBusinessHours(istDate(2026, 9, 12, 19, 0))).toBe(false);
    expect(isWithinBusinessHours(istDate(2026, 9, 12, 22, 47))).toBe(false);
    expect(isWithinBusinessHours(istDate(2026, 9, 11, 12, 0))).toBe(false); // Sunday
  });

  it("follow-ups due outside hours roll to the next opening", () => {
    const due = nextBusinessTime(istDate(2026, 9, 12, 22, 0), 60);
    expect(isWithinBusinessHours(due)).toBe(true);
  });

  it("month and festival deadlines", () => {
    expect(weeksUntilEndOfMonth(NOW, 2)).toBeGreaterThan(24); // end of March 2027
    expect(weeksUntilEndOfMonth(NOW, 9)).toBeLessThan(4); // end of this October
    expect(weeksUntilFestival(NOW, "diwali")).toBeLessThan(5);
  });
});

describe("appointment status transitions", () => {
  it("allows only defined transitions", () => {
    expect(canTransition("pending_confirmation", "confirmed")).toBe(true);
    expect(canTransition("cancelled", "confirmed")).toBe(false);
  });
  it("confirmation needs evidence — a stored preference is never 'confirmed'", () => {
    expect(validateTransition("pending_confirmation", "confirmed").ok).toBe(false);
    expect(validateTransition("pending_confirmation", "confirmed", { by: "calendar" }).ok).toBe(false);
    expect(validateTransition("pending_confirmation", "confirmed", { by: "calendar", reference: "cal_123" }).ok).toBe(true);
    expect(validateTransition("pending_confirmation", "confirmed", { by: "staff", staffUserId: "u1" }).ok).toBe(true);
  });
});

describe("metrics", () => {
  it("response stats from stored timestamps; honest nulls when empty", () => {
    expect(responseStats([])).toEqual({ total: 0, responded: 0, within5Min: 0, pctWithin5Min: null, medianSeconds: null });
    const t0 = new Date("2026-10-01T10:00:00Z");
    const s = responseStats([
      { first_contact_at: t0, first_response_at: new Date(t0.getTime() + 2000) },
      { first_contact_at: t0, first_response_at: new Date(t0.getTime() + 600_000) },
      { first_contact_at: t0, first_response_at: null },
    ]);
    expect(s.within5Min).toBe(1);
    expect(s.pctWithin5Min).toBe(33.3);
    expect(s.medianSeconds).toBe(301);
  });

  it("never mixes actual charges with estimates", () => {
    const c = costSummary([
      { provider: "anthropic", kind: "llm_tokens", quantity: 1000, unit: "tokens", cost_amount: 0.01, cost_currency: "USD", cost_type: "estimate" },
      { provider: "vaani", kind: "voice_minutes", quantity: 3, unit: "minutes", cost_amount: null, cost_currency: null, cost_type: "unavailable" },
      { provider: "x", kind: "y", quantity: 1, unit: "u", cost_amount: 2, cost_currency: "USD", cost_type: "actual" },
    ]);
    expect(c.estimated).toEqual({ USD: 0.01 });
    expect(c.actual).toEqual({ USD: 2 });
    expect(c.unavailableCount).toBe(1);
  });
});

describe("VaaniVoice adapter (documented payloads)", () => {
  it("normalises call_ended (seconds) and call_postprocessing (milliseconds, nested data)", () => {
    const ended = normalizeVaaniWebhook({ event: "call_ended", room_name: "room_1", call_duration: 42.5, end_reason: "AGENT_REQUESTED_DISCONNECT" });
    expect(ended).toMatchObject({ type: "call_ended", providerCallId: "room_1", durationSec: 42.5 });
    const post = normalizeVaaniWebhook({
      event: "call_postprocessing",
      call_id: "outbound-1",
      timestamp: "2026-07-24T13:34:22Z",
      data: { room_name: "outbound-1", call_duration: 55150, summary: "s", transcript: "[13:33:14] AGENT: Hi\n\n[13:33:19] USER: Hello", recording_url: "https://x" },
    });
    expect(post).toMatchObject({ type: "call_postprocessing", providerCallId: "outbound-1", durationSec: 55.2, summary: "s" });
  });

  it("webhook idempotency key is stable for the same delivery", () => {
    const p = { event: "call_started", room_name: "r9", status: "dialing" };
    expect(webhookEventKey(normalizeVaaniWebhook(p), p)).toBe(webhookEventKey(normalizeVaaniWebhook({ ...p }), { ...p }));
  });

  it("parses the provider transcript format", () => {
    expect(parseVaaniTranscript("[13:33:14] AGENT: Hi there\n\n[13:33:19] USER: I have a 2BHK")).toEqual([
      { speaker: "agent", text: "Hi there" },
      { speaker: "caller", text: "I have a 2BHK" },
    ]);
  });

  it("BYOL: latest caller text = user messages after the last assistant message, de-duplicated", () => {
    expect(
      latestCallerText([
        { role: "system", content: "prompt" },
        { role: "assistant", content: "How can I help?" },
        { role: "user", content: "What is this call regarding?" },
        { role: "user", content: "What is this call regarding?" },
      ]),
    ).toBe("What is this call regarding?");
    expect(parseByolMessage('{"response_type":"ping_pong"}')).toEqual({ pingPong: true });
    expect(parseByolMessage("not json")).toBeNull();
    expect(byolResponseFrame(3, "Hello", true)).toEqual({ response_type: "response", response_id: 3, content: "Hello", content_complete: true, end_call: true });
    expect(byolResponseFrame(4, "Hi", false)).not.toHaveProperty("end_call");
  });
});

describe("authentication & authorisation", () => {
  const secret = "x".repeat(40);
  it("signed sessions verify; tampering, wrong secret and expiry fail", async () => {
    const token = await signSession({ uid: "u1", role: "manager", exp: Math.floor(Date.now() / 1000) + 60 }, secret);
    expect(await verifySession(token, secret)).toMatchObject({ uid: "u1", role: "manager" });
    expect(await verifySession(token, "y".repeat(40))).toBeNull();
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "u1", role: "admin", exp: 9e9 })).toString("base64url");
    expect(await verifySession(`${forged}.${sig}`, secret)).toBeNull();
    expect(await verifySession(`${body}.${sig}x`, secret)).toBeNull();
    const old = await signSession({ uid: "u1", role: "admin", exp: 1 }, secret);
    expect(await verifySession(old, secret)).toBeNull();
    expect(await verifySession(undefined, secret)).toBeNull();
  });

  it("passwords are hashed with scrypt and verified in constant time", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).toMatch(/^scrypt\$/);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });

  it("role permissions and lead visibility", () => {
    expect(can("designer", "review:decide")).toBe(false);
    expect(can("designer", "integrations:view")).toBe(false);
    expect(can("manager", "review:decide")).toBe(true);
    expect(can("admin", "integrations:verify")).toBe(true);
    expect(canViewLead({ id: "d1", role: "designer" }, { assigned_designer_id: "d1" })).toBe(true);
    expect(canViewLead({ id: "d1", role: "designer" }, { assigned_designer_id: "d2" })).toBe(false);
    expect(canViewLead({ id: "d1", role: "designer" }, { assigned_designer_id: null })).toBe(false);
    expect(canViewLead({ id: "m1", role: "manager" }, { assigned_designer_id: null })).toBe(true);
  });

  it("secret comparison", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual(undefined, "abc")).toBe(false);
  });
});
