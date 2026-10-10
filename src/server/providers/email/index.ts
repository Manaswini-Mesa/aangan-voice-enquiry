import "server-only";
import { config } from "../../env";

// Provider-independent email interface + Resend adapter.
// Delivery results are reported exactly: "sent" only when the provider accepted the message.

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}

export type SendResult =
  | { status: "sent"; providerMessageId: string }
  | { status: "simulated"; detail: string }
  | { status: "not_configured"; detail: string }
  | { status: "failed"; error: string; retryable: boolean };

export interface EmailProvider {
  readonly name: string;
  readonly live: boolean;
  send(msg: EmailMessage): Promise<SendResult>;
  verify(): Promise<{ ok: boolean; detail: string }>;
}

export class ResendProvider implements EmailProvider {
  readonly name = "resend";
  readonly live = true;
  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async send(msg: EmailMessage): Promise<SendResult> {
    if (!msg.to.length) return { status: "not_configured", detail: "No recipients configured for this notification type." };
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": msg.idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify({ from: this.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (res.ok && body.id) return { status: "sent", providerMessageId: body.id };
      const retryable = res.status === 429 || res.status >= 500;
      return { status: "failed", error: `Resend ${res.status}: ${body.message ?? body.name ?? "request failed"}`.slice(0, 300), retryable };
    } catch (err) {
      return { status: "failed", error: `Network error: ${(err as Error).name}`, retryable: true };
    }
  }

  async verify() {
    // Sending a test email would notify real people; instead confirm the key can list domains.
    try {
      const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(8000) });
      if (res.status === 401 || res.status === 403) return { ok: false, detail: `API key rejected (${res.status}).` };
      if (!res.ok) return { ok: false, detail: `Resend responded ${res.status}. A restricted "sending only" key cannot list domains — try sending a test notification instead.` };
      const body = (await res.json()) as { data?: Array<{ name: string; status: string }> };
      const fromDomain = this.from.match(/@([^>\s]+)/)?.[1];
      if (fromDomain === "resend.dev") {
        return { ok: true, detail: "Key works. Using Resend's test sender (onboarding@resend.dev): emails can only be delivered to the address that owns the Resend account until a domain is verified." };
      }
      const domain = body.data?.find((d) => d.name === fromDomain);
      if (!domain) return { ok: false, detail: `Key works, but sender domain "${fromDomain}" is not added in Resend.` };
      return { ok: domain.status === "verified", detail: `Sender domain ${domain.name}: ${domain.status}.` };
    } catch {
      return { ok: false, detail: "Could not reach Resend." };
    }
  }
}

/** Demo mode: nothing is sent. Status is recorded as "simulated", never "sent". */
export class SimulatedEmailProvider implements EmailProvider {
  readonly name = "simulated";
  readonly live = false;
  async send(msg: EmailMessage): Promise<SendResult> {
    if (!msg.to.length) return { status: "not_configured", detail: "No recipients configured." };
    return { status: "simulated", detail: `Simulated delivery to ${msg.to.length} recipient(s); no email left the server.` };
  }
  async verify() {
    return { ok: true, detail: "Simulated — no emails are sent in demo mode." };
  }
}

/** Live mode without credentials: every attempt is recorded as not_configured (visible + retryable). */
export class UnconfiguredEmailProvider implements EmailProvider {
  readonly name = "unconfigured";
  readonly live = false;
  async send(): Promise<SendResult> {
    return { status: "not_configured", detail: "Email is not configured (RESEND_API_KEY and EMAIL_FROM)." };
  }
  async verify() {
    return { ok: false, detail: "RESEND_API_KEY and/or EMAIL_FROM not set." };
  }
}

let override: EmailProvider | undefined;
export function setEmailProviderForTests(p: EmailProvider | undefined) {
  override = p;
}

export function getEmailProvider(): EmailProvider {
  if (override) return override;
  const cfg = config();
  if (cfg.email.resendApiKey && cfg.email.from) return new ResendProvider(cfg.email.resendApiKey, cfg.email.from);
  return cfg.mode === "demo" ? new SimulatedEmailProvider() : new UnconfiguredEmailProvider();
}
