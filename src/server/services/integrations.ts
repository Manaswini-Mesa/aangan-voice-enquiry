import "server-only";
import type { Db } from "../db/client";
import { config } from "../env";
import { getAiProvider } from "../providers/ai";
import { getEmailProvider } from "../providers/email";
import { VaaniClient } from "../providers/voice/vaani";
import { getIntegrationChecks, recordIntegrationCheck } from "../repo/ops";

export type IntegrationState = "verified" | "configured_unverified" | "simulated" | "unconfigured" | "error" | "manual";

export interface IntegrationStatus {
  key: "database" | "voice" | "ai" | "email" | "scheduling" | "auth";
  name: string;
  state: IntegrationState;
  detail: string;
  /** Names of env vars involved (never values). */
  envVars: string[];
  missing: string[];
  lastCheck?: { status: string; detail: string; checked_at: string };
  canVerify: boolean;
  extra?: string[];
}

function missingVars(names: string[]): string[] {
  return names.filter((n) => !process.env[n]?.trim());
}

export async function integrationStatuses(db: Db | null, dbError?: string): Promise<IntegrationStatus[]> {
  const cfg = config();
  const checks = db ? await getIntegrationChecks(db).catch(() => ({}) as Record<string, never>) : {};
  const out: IntegrationStatus[] = [];

  // Database
  if (!db) {
    out.push({ key: "database", name: "Database", state: cfg.mode === "live" && !cfg.databaseUrl ? "unconfigured" : "error", detail: dbError ?? "Database unavailable.", envVars: ["DATABASE_URL"], missing: missingVars(["DATABASE_URL"]), canVerify: false });
  } else if (db.kind === "pglite") {
    out.push({
      key: "database",
      name: "Database",
      state: "simulated",
      detail: `Embedded demo database (PGlite) at ${cfg.isVercel ? "/tmp — resets when the server instance restarts" : "./.data/pglite — persists across restarts on this machine"}. Not production persistence.`,
      envVars: ["DATABASE_URL"],
      missing: missingVars(["DATABASE_URL"]),
      canVerify: false,
    });
  } else {
    try {
      const r = await db.query<{ v: string }>("SELECT version() AS v");
      out.push({ key: "database", name: "Database", state: "verified", detail: `PostgreSQL connected (${r[0].v.split(" ").slice(0, 2).join(" ")}); query succeeded just now.`, envVars: ["DATABASE_URL"], missing: [], canVerify: false });
    } catch (err) {
      out.push({ key: "database", name: "Database", state: "error", detail: `Query failed: ${(err as Error).message.slice(0, 120)}`, envVars: ["DATABASE_URL"], missing: [], canVerify: false });
    }
  }

  // Voice (VaaniVoice)
  const voiceVars = ["VAANI_API_KEY", "VAANI_WEBHOOK_TOKEN", "VOICE_GATEWAY_SECRET", "VAANI_AGENT_ID"];
  const liveCalls = db ? Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM calls WHERE provider = 'vaani' AND mode = 'live'`))[0].n) : 0;
  const liveWebhooks = db ? Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM webhook_events WHERE provider = 'vaani' AND status = 'processed'`))[0].n) : 0;
  const vCheck = (checks as Record<string, { status: string; detail: string; checked_at: string }>).voice;
  const extra = [
    `Live VaaniVoice calls recorded: ${liveCalls}. Processed webhooks: ${liveWebhooks}.`,
    cfg.vaani.webhookToken ? "Webhook URL token: configured." : "Webhook URL token: NOT configured (webhook endpoint rejects all requests).",
    cfg.vaani.gatewaySecret ? "Voice gateway secret: configured." : "Voice gateway secret: NOT configured (BYOL turn endpoint rejects all requests).",
  ];
  if (!cfg.vaani.apiKey) {
    out.push({
      key: "voice",
      name: "Voice — VaaniVoice",
      state: cfg.mode === "demo" ? "simulated" : "unconfigured",
      detail: cfg.mode === "demo" ? "Calls are simulated in the dashboard simulator. No phone calls are answered." : "VAANI_API_KEY not set. No live calls can be verified.",
      envVars: voiceVars,
      missing: missingVars(voiceVars),
      canVerify: false,
      extra,
    });
  } else {
    const state: IntegrationState = vCheck ? (vCheck.status === "ok" ? (liveCalls > 0 ? "verified" : "configured_unverified") : "error") : "configured_unverified";
    out.push({
      key: "voice",
      name: "Voice — VaaniVoice",
      state,
      detail:
        state === "verified"
          ? "API key verified and live calls have been received."
          : state === "error"
            ? `Last check failed: ${vCheck?.detail}`
            : vCheck?.status === "ok"
              ? "API key verified, but no live call has been received yet — the phone path is not proven until a real inbound call arrives."
              : "API key set but not yet verified. Use Verify.",
      envVars: voiceVars,
      missing: missingVars(voiceVars),
      lastCheck: vCheck,
      canVerify: true,
      extra,
    });
  }

  // AI
  const aCheck = (checks as Record<string, { status: string; detail: string; checked_at: string }>).ai;
  if (!cfg.anthropic.apiKey) {
    out.push({ key: "ai", name: "AI model — Anthropic Claude", state: "simulated", detail: "No ANTHROPIC_API_KEY: deterministic rule-based extraction and summaries are used (no model calls).", envVars: ["ANTHROPIC_API_KEY", "AI_MODEL"], missing: missingVars(["ANTHROPIC_API_KEY"]), canVerify: false });
  } else {
    out.push({
      key: "ai",
      name: "AI model — Anthropic Claude",
      state: aCheck ? (aCheck.status === "ok" ? "verified" : "error") : "configured_unverified",
      detail: `${aCheck ? aCheck.detail : "Key set; not yet verified."} Model: ${cfg.anthropic.model}. Turn extraction ${cfg.anthropic.turnExtraction ? "on" : "off"}; rules remain authoritative.`,
      envVars: ["ANTHROPIC_API_KEY", "AI_MODEL"],
      missing: [],
      lastCheck: aCheck,
      canVerify: true,
    });
  }

  // Email
  const eCheck = (checks as Record<string, { status: string; detail: string; checked_at: string }>).email;
  const emailVars = ["RESEND_API_KEY", "EMAIL_FROM", "NOTIFY_HANDOFF_TO", "NOTIFY_REVIEW_TO", "NOTIFY_COMPLAINTS_TO"];
  const provider = getEmailProvider();
  const sentCount = db ? Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE status = 'sent'`))[0].n) : 0;
  if (provider.name === "resend") {
    out.push({
      key: "email",
      name: "Email — Resend",
      state: eCheck ? (eCheck.status === "ok" ? (sentCount > 0 ? "verified" : "configured_unverified") : "error") : sentCount > 0 ? "verified" : "configured_unverified",
      detail: `${eCheck?.detail ?? "Configured; not yet verified."} Emails accepted by Resend so far: ${sentCount}.`,
      envVars: emailVars,
      missing: missingVars(emailVars),
      lastCheck: eCheck,
      canVerify: true,
    });
  } else {
    out.push({
      key: "email",
      name: "Email — Resend",
      state: provider.name === "simulated" ? "simulated" : "unconfigured",
      detail: provider.name === "simulated" ? "Demo mode: notifications are recorded as “simulated” and never sent." : "RESEND_API_KEY / EMAIL_FROM missing: notifications are saved as “not configured” and can be retried once set up.",
      envVars: emailVars,
      missing: missingVars(emailVars),
      canVerify: false,
    });
  }

  out.push({
    key: "scheduling",
    name: "Calendar / scheduling",
    state: "manual",
    detail: "No calendar integration. Consultation requests are stored as “needs human confirmation”; no availability is invented.",
    envVars: [],
    missing: [],
    canVerify: false,
  });

  out.push({
    key: "auth",
    name: "Dashboard authentication",
    state: cfg.authSecretIsDevFallback ? (cfg.mode === "live" ? "unconfigured" : "simulated") : "verified",
    detail: cfg.authSecretIsDevFallback
      ? cfg.mode === "live"
        ? "AUTH_SECRET missing or shorter than 32 characters — sign-in is disabled in live mode."
        : "Demo mode uses a built-in session secret. Set AUTH_SECRET (32+ chars) before using real data."
      : "Signed session cookies with AUTH_SECRET; role-based access enforced on the server.",
    envVars: ["AUTH_SECRET", "BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_ADMIN_PASSWORD"],
    missing: missingVars(["AUTH_SECRET"]),
    canVerify: false,
  });
  return out;
}

export async function verifyIntegration(db: Db, key: "voice" | "ai" | "email"): Promise<{ ok: boolean; detail: string }> {
  const cfg = config();
  let r: { ok: boolean; detail: string };
  if (key === "voice") {
    if (!cfg.vaani.apiKey) r = { ok: false, detail: "VAANI_API_KEY not set." };
    else r = await new VaaniClient(cfg.vaani.apiKey, cfg.vaani.baseUrl).verify(cfg.vaani.agentId);
  } else if (key === "ai") {
    const p = getAiProvider();
    r = p.live ? await p.verify() : { ok: false, detail: "ANTHROPIC_API_KEY not set." };
  } else {
    r = await getEmailProvider().verify();
  }
  await recordIntegrationCheck(db, key, r.ok ? "ok" : "error", r.detail);
  return r;
}
