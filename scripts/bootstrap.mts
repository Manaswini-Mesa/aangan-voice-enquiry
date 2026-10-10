// One-off setup against the configured database: creates the bootstrap admin (live mode) and,
// when SEED_SIMULATED_EXAMPLES=true, labelled example records. Usage: npm run db:bootstrap
import { loadEnvFile } from "node:process";
import fs from "node:fs";

if (fs.existsSync(".env.local")) loadEnvFile(".env.local");
const { ensureBootstrapped } = await import("../src/server/bootstrap.ts");
const { getDb } = await import("../src/server/db/client.ts");
await ensureBootstrapped();
const db = await getDb();
const users = await db.query<{ email: string; role: string }>("SELECT email, role FROM users ORDER BY role");
const leads = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM leads");
console.log(`Database (${db.kind}): ${users.length} user(s): ${users.map((u) => `${u.email} [${u.role}]`).join(", ")}; ${leads[0].n} lead(s).`);
process.exit(0);
