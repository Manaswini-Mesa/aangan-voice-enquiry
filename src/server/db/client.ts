import "server-only";
import fs from "node:fs";
import path from "node:path";
import { config } from "../env";

// Database access. One tiny interface over two engines:
//  - live mode: PostgreSQL (Neon) through `pg`
//  - demo mode: PGlite, an embedded PostgreSQL that persists to a local directory
// Business logic only sees `Db`, so swapping vendors does not touch it.

export interface Db {
  kind: "postgres" | "pglite";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export class DatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseUnavailableError";
  }
}

type PgPool = import("pg").Pool;
type PGliteT = import("@electric-sql/pglite").PGlite;

interface Holder {
  db?: Promise<Db>;
  override?: Db;
}
const g = globalThis as unknown as { __aanganDb?: Holder };
const holder: Holder = (g.__aanganDb ??= {});

function wrapPg(pool: PgPool): Db {
  const make = (runner: { query: PgPool["query"] }): Db => ({
    kind: "postgres",
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await runner.query(sql, params as unknown[]);
      return res.rows as T[];
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      if (runner !== pool) return fn(make(runner));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(make(client as unknown as PgPool));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  });
  return make(pool);
}

export function wrapPglite(pg: PGliteT): Db {
  // PGlite is single-connection; serialise transactions with a simple queue.
  let chain: Promise<unknown> = Promise.resolve();
  const make = (runner: Pick<PGliteT, "query">, inTx: boolean): Db => ({
    kind: "pglite",
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await runner.query<T>(sql, params as unknown[]);
      return res.rows;
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      if (inTx) return fn(make(runner, true));
      const run = chain.then(() => pg.transaction(async (t) => fn(make(t as unknown as PGliteT, true))));
      chain = run.catch(() => {});
      return run as Promise<T>;
    },
  });
  return make(pg, false);
}

function migrationFiles(): Array<{ name: string; sql: string }> {
  const dir = path.join(process.cwd(), "migrations");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), "utf8") }));
}

export async function migrate(db: Db, exec: (sql: string) => Promise<void>): Promise<string[]> {
  await exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const ran: string[] = [];
  for (const m of migrationFiles()) {
    if (applied.has(m.name)) continue;
    await exec(m.sql);
    await db.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING", [m.name]);
    ran.push(m.name);
  }
  return ran;
}

async function connectPostgres(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 20000,
    statement_timeout: 15000,
    ssl: /sslmode=disable/.test(url) || /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true },
  });
  const db = wrapPg(pool);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727274)");
    await migrate(db, async (sql) => {
      await client.query(sql);
    });
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
  return db;
}

async function connectPglite(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dir !== "memory://") fs.mkdirSync(dir, { recursive: true });
  const pg = dir === "memory://" ? new PGlite() : new PGlite(dir);
  await pg.waitReady;
  const db = wrapPglite(pg);
  await migrate(db, async (sql) => {
    await pg.exec(sql);
  });
  return db;
}

/** Returns the process-wide database, connecting and migrating on first use. */
export async function getDb(): Promise<Db> {
  if (holder.override) return holder.override;
  if (!holder.db) {
    const cfg = config();
    if (cfg.databaseUrl) {
      // Live mode always; demo mode too when a database is supplied (records are flagged is_demo).
      holder.db = connectPostgres(cfg.databaseUrl);
    } else if (cfg.mode === "live") {
      throw new DatabaseUnavailableError("Live mode requires DATABASE_URL. No customer data can be stored until it is configured.");
    } else {
      holder.db = connectPglite(cfg.demoDataDir);
    }
    holder.db.catch(() => {
      holder.db = undefined; // allow retry after a failed connection
    });
  }
  return holder.db;
}

/** Test hook: use a specific database instance (e.g. in-memory PGlite). */
export function setDbForTests(db: Db | undefined) {
  holder.override = db;
}

export async function createMemoryDb(): Promise<Db> {
  return connectPglite("memory://");
}
