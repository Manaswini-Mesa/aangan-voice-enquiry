import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ensureBootstrapped } from "../bootstrap";
import { getDb } from "../db/client";
import { config } from "../env";
import { findUserById } from "../repo/users";
import { can, type Permission } from "./permissions";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession, verifySession, type Role } from "./session-token";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  isDemo: boolean;
}

export async function createSessionCookie(user: { id: string; role: Role }) {
  const secret = config().authSecret;
  if (!secret) throw new Error("AUTH_SECRET is not configured");
  const token = await signSession({ uid: user.id, role: user.role, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }, secret);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Resolves the signed-in user from the cookie AND the database (deactivated users lose access). */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const payload = await verifySession(token, config().authSecret);
  if (!payload) return null;
  await ensureBootstrapped();
  const db = await getDb();
  const u = await findUserById(db, payload.uid);
  if (!u || !u.active) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, isDemo: u.is_demo };
}

/** For server components/pages: redirects to /login when not signed in. */
export async function requireUser(permission?: Permission): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (permission && !can(user.role, permission)) redirect("/?denied=1");
  return user;
}
