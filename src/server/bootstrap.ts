import "server-only";
import { SCENARIOS } from "@/core/scenarios";
import { getDb, type Db } from "./db/client";
import { config } from "./env";
import { audit, opsEvent, SYSTEM_ACTOR } from "./repo/ops";
import { countUsers, createUser } from "./repo/users";
import { endCall, handleCallerTurn, istAt } from "./services/calls";
import { dispatchPending } from "./services/notifications";

// First-run setup.
//  - Live mode: creates the bootstrap admin from BOOTSTRAP_ADMIN_EMAIL/PASSWORD if no users exist.
//  - Demo mode: creates demo users and seeds SYNTHETIC enquiries by running the scenario scripts
//    through the real conversation + qualification engine. Every seeded record is flagged
//    is_simulated = true and shown with a "Simulated" badge.

const g = globalThis as unknown as { __aanganBoot?: Promise<void> };

export const DEMO_USERS = [
  { email: "admin@aangan.demo", name: "Demo Admin", role: "admin" as const },
  { email: "manager@aangan.demo", name: "Demo Studio Manager", role: "manager" as const },
  { email: "designer.riya@aangan.demo", name: "Riya (Designer, demo)", role: "designer" as const },
  { email: "designer.kunal@aangan.demo", name: "Kunal (Designer, demo)", role: "designer" as const },
];

const SEED_TIMES: Array<[number, number, number]> = [
  [1, 10, 23], [2, 22, 47], [3, 14, 41], [4, 11, 7], [5, 7, 52], [6, 15, 28], [7, 20, 15], [8, 9, 44], [9, 11, 32],
  [10, 14, 4], [11, 10, 18], [12, 21, 30], [13, 16, 12], [14, 11, 55], [15, 15, 2], [16, 8, 40], [17, 23, 5], [18, 12, 19],
  [19, 13, 45], [20, 18, 20], [21, 10, 10],
];

export async function seedDemoData(db: Db, now = new Date()): Promise<number> {
  const existing = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM leads`);
  if (Number(existing[0].n) > 0) return 0;
  let i = 0;
  const pending: string[] = [];
  for (const sc of SCENARIOS) {
    const [daysAgo, h, m] = SEED_TIMES[i % SEED_TIMES.length];
    const at = istAt(now, daysAgo, h, m);
    const key = { provider: "simulator", providerCallId: `seed-${sc.id}`, mode: "simulated" as const };
    let ended = false;
    let t = 0;
    for (const text of sc.turns) {
      const r = await handleCallerTurn(db, { ...key, text, callerNumber: sc.callerNumber, at: new Date(at.getTime() + t++ * 20_000), turnKey: `seed-${sc.id}-${t}` });
      pending.push(...r.pendingNotifications);
      if (r.endCall) {
        ended = true;
        break;
      }
    }
    if (!ended || sc.disconnectAfter) {
      const r = await endCall(db, key, { reason: sc.disconnectAfter ? "caller_hung_up" : "completed", at: new Date(at.getTime() + t * 20_000) });
      pending.push(...r.pendingNotifications);
    }
    i++;
  }
  await dispatchPending(db, pending);
  // One notification is marked failed so the failure/retry workflow can be demonstrated.
  await db.query(
    `UPDATE notifications SET status = 'failed', last_error = 'Simulated provider outage (demo data) — use Retry to resend' WHERE id = (
       SELECT n.id FROM notifications n WHERE n.kind = 'handoff' ORDER BY n.created_at LIMIT 1)`,
  );
  await opsEvent(db, "info", "seed", "DEMO_SEEDED", `Seeded ${SCENARIOS.length} synthetic enquiries through the real engine.`);
  return SCENARIOS.length;
}

async function run(): Promise<void> {
  const cfg = config();
  const db = await getDb();
  if ((await countUsers(db)) === 0) {
    if (cfg.mode === "demo") {
      for (const u of DEMO_USERS) await createUser(db, { ...u, password: cfg.demoPassword, isDemo: true });
      await audit(db, SYSTEM_ACTOR, "users.demo_created", "user", "demo", null, undefined, { count: DEMO_USERS.length });
    } else if (cfg.bootstrapAdmin) {
      await createUser(db, { email: cfg.bootstrapAdmin.email, name: cfg.bootstrapAdmin.name, role: "admin", password: cfg.bootstrapAdmin.password });
      await audit(db, SYSTEM_ACTOR, "users.bootstrap_admin_created", "user", cfg.bootstrapAdmin.email, null);
    }
  }
  // Demo mode seeds by default. Live mode can opt in (SEED_SIMULATED_EXAMPLES=true) to show labelled
  // example records next to real data; they are flagged is_simulated and hidden from live metrics.
  const seed = cfg.mode === "demo" ? process.env.DEMO_SEED !== "off" : process.env.SEED_SIMULATED_EXAMPLES === "true";
  if (seed) await seedDemoData(db);
}

/** Runs once per server process; safe to call from every request. */
export function ensureBootstrapped(): Promise<void> {
  if (!g.__aanganBoot) {
    g.__aanganBoot = run().catch((err) => {
      g.__aanganBoot = undefined;
      throw err;
    });
  }
  return g.__aanganBoot;
}
