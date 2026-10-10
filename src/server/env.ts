import "server-only";
import { buildRules, type RuleConfig } from "@/core/rules";

// Server-side configuration. Never import this from a client component.
// Secrets are read from process.env only on the server and are never logged or rendered.

export type AppMode = "demo" | "live";

function str(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function list(name: string): string[] {
  return (str(name) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface AppConfig {
  mode: AppMode;
  isVercel: boolean;
  appBaseUrl?: string;
  databaseUrl?: string;
  /** PGlite directory for demo mode. */
  demoDataDir: string;
  authSecret?: string;
  authSecretIsDevFallback: boolean;
  demoPassword: string;
  bootstrapAdmin?: { email: string; password: string; name: string };
  anthropic: { apiKey?: string; model: string; turnExtraction: boolean; timeoutMs: number; inputUsdPerMTok?: number; outputUsdPerMTok?: number };
  vaani: { apiKey?: string; baseUrl: string; webhookToken?: string; gatewaySecret?: string; agentId?: string; inrPerMinuteEstimate?: number };
  email: {
    resendApiKey?: string;
    from?: string;
    handoffTo: string[];
    reviewTo: string[];
    complaintsTo: string[];
    opsTo: string[];
    usdPerEmailEstimate?: number;
  };
  recordingEnabled: boolean;
  transcriptRetentionDays: number;
  cronSecret?: string;
  rules: RuleConfig;
}

function num(name: string): number | undefined {
  const v = str(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

let cached: AppConfig | undefined;

export function config(): AppConfig {
  if (cached) return cached;
  const mode: AppMode = str("APP_MODE") === "live" ? "live" : "demo";
  const isVercel = !!process.env.VERCEL;
  const authSecret = str("AUTH_SECRET");
  const usableSecret = authSecret && authSecret.length >= 32 ? authSecret : undefined;
  const bootstrapEmail = str("BOOTSTRAP_ADMIN_EMAIL");
  const bootstrapPassword = str("BOOTSTRAP_ADMIN_PASSWORD");
  const demoTo = ["studio-team@example.test"];
  cached = {
    mode,
    isVercel,
    appBaseUrl: str("APP_BASE_URL")?.replace(/\/$/, ""),
    databaseUrl: str("DATABASE_URL"),
    demoDataDir: str("DEMO_DATA_DIR") ?? (isVercel ? "/tmp/aangan-pglite" : ".data/pglite"),
    authSecret: usableSecret ?? (mode === "demo" ? "demo-mode-insecure-session-secret-do-not-use-live" : undefined),
    authSecretIsDevFallback: !usableSecret,
    demoPassword: str("DEMO_PASSWORD") ?? "aangan-demo-2026",
    bootstrapAdmin:
      bootstrapEmail && bootstrapPassword && bootstrapPassword.length >= 12
        ? { email: bootstrapEmail.toLowerCase(), password: bootstrapPassword, name: str("BOOTSTRAP_ADMIN_NAME") ?? "Studio Admin" }
        : undefined,
    anthropic: {
      apiKey: str("ANTHROPIC_API_KEY"),
      model: str("AI_MODEL") ?? "claude-opus-5-5",
      turnExtraction: str("AI_TURN_EXTRACTION") !== "off",
      timeoutMs: num("AI_TIMEOUT_MS") ?? 4000,
      inputUsdPerMTok: num("AI_INPUT_USD_PER_MTOK"),
      outputUsdPerMTok: num("AI_OUTPUT_USD_PER_MTOK"),
    },
    vaani: {
      apiKey: str("VAANI_API_KEY"),
      baseUrl: (str("VAANI_API_BASE_URL") ?? "https://api.vaanivoice.ai").replace(/\/$/, ""),
      webhookToken: str("VAANI_WEBHOOK_TOKEN"),
      gatewaySecret: str("VOICE_GATEWAY_SECRET"),
      agentId: str("VAANI_AGENT_ID"),
      inrPerMinuteEstimate: num("VAANI_INR_PER_MINUTE_ESTIMATE"),
    },
    email: {
      resendApiKey: str("RESEND_API_KEY"),
      from: str("EMAIL_FROM"),
      handoffTo: list("NOTIFY_HANDOFF_TO").length ? list("NOTIFY_HANDOFF_TO") : mode === "demo" ? demoTo : [],
      reviewTo: list("NOTIFY_REVIEW_TO").length ? list("NOTIFY_REVIEW_TO") : mode === "demo" ? demoTo : [],
      complaintsTo: list("NOTIFY_COMPLAINTS_TO").length ? list("NOTIFY_COMPLAINTS_TO") : mode === "demo" ? demoTo : [],
      opsTo: list("NOTIFY_OPS_TO"),
      usdPerEmailEstimate: num("EMAIL_USD_PER_EMAIL_ESTIMATE"),
    },
    recordingEnabled: str("CALL_RECORDING_ENABLED") === "true",
    transcriptRetentionDays: num("TRANSCRIPT_RETENTION_DAYS") ?? 365,
    cronSecret: str("CRON_SECRET"),
    rules: buildRules({ commercialMinStatus: str("COMMERCIAL_MIN_STATUS"), budgetFloorsJson: str("BUDGET_REVIEW_FLOORS") }),
  };
  return cached;
}

/** For tests only. */
export function resetConfigForTests() {
  cached = undefined;
}

export function dashboardUrl(path = ""): string | undefined {
  const base = config().appBaseUrl;
  return base ? `${base}${path}` : undefined;
}
