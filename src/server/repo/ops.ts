import "server-only";
import type { Db } from "../db/client";

// Audit history, operational events and integration checks.

export interface Actor {
  id?: string;
  label: string;
}

export const SYSTEM_ACTOR: Actor = { label: "system" };

export async function audit(
  db: Db,
  actor: Actor,
  action: string,
  entity: string,
  entityId: string,
  leadId: string | null,
  before?: unknown,
  after?: unknown,
) {
  await db.query(
    `INSERT INTO audit_log (actor_id, actor_label, action, entity, entity_id, lead_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actor.id ?? null, actor.label, action, entity, entityId, leadId, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after)],
  );
}

/** Operational log. Messages must not contain personal data or secrets. */
export async function opsEvent(
  db: Db,
  level: "info" | "warn" | "error",
  source: string,
  code: string,
  message: string,
  leadId?: string | null,
  metadata: Record<string, unknown> = {},
) {
  try {
    await db.query(`INSERT INTO ops_events (level, source, code, message, lead_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)`, [
      level,
      source,
      code,
      message.slice(0, 500),
      leadId ?? null,
      JSON.stringify(metadata),
    ]);
  } catch (err) {
    // Last resort: structured console log without personal data.
    console.error(JSON.stringify({ level: "error", source: "ops_events", code: "OPS_WRITE_FAILED", detail: (err as Error).message.slice(0, 200) }));
  }
}

export async function recordIntegrationCheck(db: Db, integration: string, status: string, detail: string) {
  await db.query(
    `INSERT INTO integration_checks (integration, status, detail, checked_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (integration) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, checked_at = now()`,
    [integration, status, detail.slice(0, 300)],
  );
}

export async function getIntegrationChecks(db: Db): Promise<Record<string, { status: string; detail: string; checked_at: string }>> {
  const rows = await db.query<{ integration: string; status: string; detail: string; checked_at: string }>(`SELECT * FROM integration_checks`);
  return Object.fromEntries(rows.map((r) => [r.integration, r]));
}
