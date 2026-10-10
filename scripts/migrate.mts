// Applies database migrations. Usage: npm run db:migrate
// Uses DATABASE_URL when set (PostgreSQL / Neon); otherwise the local demo database (PGlite).
import { loadEnvFile } from "node:process";
import fs from "node:fs";

if (fs.existsSync(".env.local")) loadEnvFile(".env.local");
else if (fs.existsSync(".env")) loadEnvFile(".env");

const { getDb } = await import("../src/server/db/client.ts");
const db = await getDb();
const rows = await db.query<{ name: string; applied_at: string }>("SELECT name, applied_at FROM schema_migrations ORDER BY name");
console.log(`Database (${db.kind}) is up to date. Applied migrations:`);
for (const r of rows) console.log(`  ${r.name}  ${new Date(r.applied_at).toISOString()}`);
process.exit(0);
