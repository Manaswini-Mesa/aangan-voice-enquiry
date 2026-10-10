import "server-only";
import type { Db } from "../db/client";
import { config } from "../env";
import { getEmailProvider, SimulatedEmailProvider } from "../providers/email";
import { audit, opsEvent, type Actor } from "../repo/ops";
import type { NotificationRow } from "../repo/types";
import type { Rendered } from "./notification-templates";

// Notification workflow:
//  1. createNotification() persists a row (status "pending") inside the caller's transaction,
//     with a unique idempotency key — the business record (handoff/escalation) never depends on it.
//  2. dispatchNotification() attempts delivery after commit and records the exact outcome.
//  3. Retries reuse the same idempotency key (also sent to Resend), so a retry cannot send twice.

export type NotificationKind = "handoff" | "review" | "complaint" | "existing_client" | "ops_overdue";

export async function createNotification(
  db: Db,
  input: { leadId: string | null; kind: NotificationKind; recipients: string[]; content: Rendered; idempotencyKey: string },
): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO notifications (lead_id, kind, recipients, subject, body_text, body_html, status, mode, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [input.leadId, input.kind, JSON.stringify(input.recipients), input.content.subject, input.content.text, input.content.html, config().mode, input.idempotencyKey],
  );
  return rows[0]?.id ?? null;
}

export async function dispatchNotification(db: Db, id: string, actor?: Actor): Promise<NotificationRow | undefined> {
  // Claim the row: only pending/failed/not_configured rows are attempted; sent/simulated never resend.
  const claimed = await db.query<NotificationRow>(
    `UPDATE notifications SET attempts = attempts + 1, last_attempt_at = now()
     WHERE id = $1 AND status IN ('pending','failed','not_configured')
       AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '5 seconds' OR status <> 'pending')
     RETURNING *`,
    [id],
  );
  const n = claimed[0];
  if (!n) return (await db.query<NotificationRow>(`SELECT * FROM notifications WHERE id = $1`, [id]))[0];

  // Notifications about simulated calls never reach real inboxes unless explicitly allowed.
  const simulatedLead = n.lead_id
    ? (await db.query<{ is_simulated: boolean }>(`SELECT is_simulated FROM leads WHERE id = $1`, [n.lead_id]))[0]?.is_simulated
    : false;
  const provider = simulatedLead && process.env.SIMULATED_CALLS_SEND_EMAIL !== "true" ? new SimulatedEmailProvider() : getEmailProvider();
  const result = await provider.send({ to: n.recipients, subject: n.subject, html: n.body_html, text: n.body_text, idempotencyKey: n.idempotency_key });

  let status: NotificationRow["status"];
  let error: string | null = null;
  let messageId: string | null = null;
  switch (result.status) {
    case "sent":
      status = "sent";
      messageId = result.providerMessageId;
      break;
    case "simulated":
      status = "simulated";
      break;
    case "not_configured":
      status = "not_configured";
      error = result.detail;
      break;
    default:
      status = "failed";
      error = result.error;
  }
  const updated = await db.query<NotificationRow>(
    `UPDATE notifications SET status = $2, last_error = $3, provider = $4, provider_message_id = COALESCE($5, provider_message_id),
       sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
     WHERE id = $1 RETURNING *`,
    [id, status, error, provider.name, messageId],
  );
  if (status === "failed" || status === "not_configured") {
    await opsEvent(db, status === "failed" ? "error" : "warn", "notifications", `EMAIL_${status.toUpperCase()}`, `${n.kind} notification ${status}: ${error ?? ""}`, n.lead_id, { notificationId: id, attempt: n.attempts });
  }
  if (status === "sent") {
    const est = config().email.usdPerEmailEstimate;
    await db.query(
      `INSERT INTO usage_events (lead_id, provider, kind, quantity, unit, cost_amount, cost_currency, cost_type, mode, idempotency_key)
       VALUES ($1,'resend','email',1,'email',$2,$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING`,
      [n.lead_id, est ?? null, est !== undefined ? "USD" : null, est !== undefined ? "estimate" : "unavailable", config().mode, `email:${n.idempotency_key}`],
    );
  }
  if (actor) await audit(db, actor, "notification.retry", "notification", id, n.lead_id, { status: n.status }, { status });
  return updated[0];
}

export async function dispatchPending(db: Db, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await dispatchNotification(db, id);
    } catch (err) {
      await opsEvent(db, "error", "notifications", "DISPATCH_EXCEPTION", `Dispatch threw: ${(err as Error).message.slice(0, 200)}`, null, { notificationId: id });
    }
  }
}
