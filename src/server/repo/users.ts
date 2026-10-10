import "server-only";
import type { Db } from "../db/client";
import { hashPassword } from "../auth/password";
import type { UserRow } from "./types";

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  const rows = await db.query<UserRow>(`SELECT * FROM users WHERE lower(email) = lower($1)`, [email.trim()]);
  return rows[0];
}

export async function findUserById(db: Db, id: string): Promise<UserRow | undefined> {
  const rows = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0];
}

export async function listUsers(db: Db): Promise<Omit<UserRow, "password_hash">[]> {
  return db.query(`SELECT id, email, name, role, active, is_demo, created_at, last_login_at FROM users ORDER BY role, name`);
}

export async function listDesigners(db: Db): Promise<Array<{ id: string; name: string; email: string }>> {
  return db.query(`SELECT id, name, email FROM users WHERE role IN ('designer','manager','admin') AND active ORDER BY role = 'designer' DESC, name`);
}

export async function createUser(
  db: Db,
  input: { email: string; name: string; role: UserRow["role"]; password: string; isDemo?: boolean },
): Promise<UserRow> {
  const hash = await hashPassword(input.password);
  const rows = await db.query<UserRow>(
    `INSERT INTO users (email, name, role, password_hash, is_demo) VALUES (lower($1), $2, $3, $4, $5) RETURNING *`,
    [input.email.trim(), input.name, input.role, hash, !!input.isDemo],
  );
  return rows[0];
}

export async function countUsers(db: Db): Promise<number> {
  const rows = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM users`);
  return Number(rows[0].n);
}

export async function touchLogin(db: Db, id: string) {
  await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [id]);
}
