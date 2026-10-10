"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { AppointmentStatus } from "@/core/appointments";
import { ensureBootstrapped } from "@/server/bootstrap";
import { can } from "@/server/auth/permissions";
import { verifyPassword } from "@/server/auth/password";
import { clearSessionCookie, createSessionCookie, getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { config } from "@/server/env";
import { clientIp, rateLimit } from "@/server/rate-limit";
import { audit } from "@/server/repo/ops";
import { findUserByEmail, touchLogin } from "@/server/repo/users";
import { verifyIntegration } from "@/server/services/integrations";
import * as wf from "@/server/services/workflow";

function back(form: FormData, fallback: string): string {
  const r = String(form.get("returnTo") ?? "");
  return r.startsWith("/") && !r.startsWith("//") ? r : fallback;
}

function withMsg(path: string, key: "ok" | "err", msg: string): string {
  const [beforeHash, hash] = path.split("#");
  const [p, q] = beforeHash.split("?");
  const params = new URLSearchParams(q);
  params.delete("ok");
  params.delete("err");
  params.set(key, msg.slice(0, 200));
  return `${p}?${params.toString()}${hash ? `#${hash}` : ""}`;
}

async function staff() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

async function run(form: FormData, fallback: string, fn: (user: Awaited<ReturnType<typeof staff>>) => Promise<string>) {
  const user = await staff();
  const target = back(form, fallback);
  let dest: string;
  try {
    const msg = await fn(user);
    revalidatePath("/", "layout");
    dest = withMsg(target, "ok", msg);
  } catch (err) {
    const e = err as Error;
    dest = withMsg(target, "err", e instanceof wf.ForbiddenError || e instanceof wf.WorkflowError ? e.message : "Something went wrong. The action was not completed.");
  }
  redirect(dest);
}

// ---------------------------------------------------------------- auth

export async function loginAction(_prev: { error?: string } | undefined, form: FormData): Promise<{ error?: string }> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const ip = clientIp(await headers());
  if (!rateLimit(`login:${ip}`, 10, 60_000).ok || !rateLimit(`login:${email}`, 5, 60_000).ok) {
    return { error: "Too many attempts. Please wait a minute and try again." };
  }
  const cfg = config();
  if (!cfg.authSecret) return { error: "Sign-in is disabled: AUTH_SECRET is not configured on the server." };
  if (!email || !password) return { error: "Enter your email and password." };
  try {
    await ensureBootstrapped();
    const db = await getDb();
    const user = await findUserByEmail(db, email);
    const ok = user && user.active && (await verifyPassword(password, user.password_hash));
    if (!user || !ok) {
      await audit(db, { label: "anonymous" }, "auth.login_failed", "user", email.slice(0, 80), null);
      return { error: "Incorrect email or password." };
    }
    await touchLogin(db, user.id);
    await audit(db, { id: user.id, label: user.name }, "auth.login", "user", user.id, null);
    await createSessionCookie({ id: user.id, role: user.role });
  } catch {
    return { error: "Sign-in is temporarily unavailable (database not reachable)." };
  }
  redirect("/");
}

export async function logoutAction() {
  await clearSessionCookie();
  redirect("/login");
}

// ---------------------------------------------------------------- workflow

export async function reviewDecisionAction(form: FormData) {
  await run(form, "/review", async (u) => {
    const decision = String(form.get("decision")) as wf.ReviewDecision;
    if (!["qualify", "decline", "needs_more_info"].includes(decision)) throw new wf.WorkflowError("Choose a decision.");
    await wf.recordReviewDecision(await getDb(), u, String(form.get("leadId")), decision, String(form.get("rationale") ?? ""));
    return "Review decision recorded. The original automated assessment is preserved.";
  });
}

export async function assignDesignerAction(form: FormData) {
  await run(form, "/workspace", async (u) => {
    await wf.assignDesigner(await getDb(), u, String(form.get("leadId")), String(form.get("designerId")));
    return "Designer assigned.";
  });
}

export async function completeFollowUpAction(form: FormData) {
  await run(form, "/workspace", async (u) => {
    await wf.completeFollowUp(await getDb(), u, String(form.get("followUpId")), String(form.get("outcome") ?? ""));
    return "Follow-up marked done.";
  });
}

export async function addFollowUpAction(form: FormData) {
  await run(form, "/workspace", async (u) => {
    const due = new Date(`${String(form.get("dueDate"))}T${String(form.get("dueTime") || "11:00")}:00+05:30`);
    if (Number.isNaN(due.getTime())) throw new wf.WorkflowError("Enter a valid due date.");
    await wf.addFollowUp(await getDb(), u, String(form.get("leadId")), String(form.get("kind") || "follow_up"), due, String(form.get("notes") ?? ""));
    return "Follow-up added.";
  });
}

export async function complaintAction(form: FormData) {
  await run(form, "/complaints", async (u) => {
    const status = String(form.get("status")) as "acknowledged" | "resolved";
    if (!["acknowledged", "resolved"].includes(status)) throw new wf.WorkflowError("Invalid status.");
    await wf.updateComplaint(await getDb(), u, String(form.get("complaintId")), status, String(form.get("note") ?? ""));
    return `Complaint ${status}.`;
  });
}

export async function appointmentAction(form: FormData) {
  await run(form, "/workspace", async (u) => {
    await wf.updateAppointment(await getDb(), u, String(form.get("leadId")), String(form.get("status")) as AppointmentStatus, String(form.get("note") ?? ""));
    return "Appointment updated.";
  });
}

export async function closeLeadAction(form: FormData) {
  await run(form, "/enquiries", async (u) => {
    await wf.closeLead(await getDb(), u, String(form.get("leadId")), String(form.get("reason") ?? "Closed by staff"));
    return "Enquiry closed.";
  });
}

export async function retryNotificationAction(form: FormData) {
  await run(form, "/workspace", async (u) => {
    const n = await wf.retryNotification(await getDb(), u, String(form.get("notificationId")));
    const label: Record<string, string> = {
      sent: "Email accepted by the provider.",
      simulated: "Simulated delivery recorded (demo — no email sent).",
      failed: `Retry failed: ${n?.last_error ?? "unknown error"}`,
      not_configured: "Email is still not configured — set RESEND_API_KEY and EMAIL_FROM.",
      pending: "Retry already in progress.",
    };
    if (n?.status === "failed" || n?.status === "not_configured") throw new wf.WorkflowError(label[n.status]);
    return label[n?.status ?? "pending"];
  });
}

export async function verifyIntegrationAction(form: FormData) {
  await run(form, "/integrations", async (u) => {
    if (!can(u.role, "integrations:verify")) throw new wf.ForbiddenError();
    const key = String(form.get("key")) as "voice" | "ai" | "email";
    if (!["voice", "ai", "email"].includes(key)) throw new wf.WorkflowError("Unknown integration.");
    const r = await verifyIntegration(await getDb(), key);
    if (!r.ok) throw new wf.WorkflowError(`Verification failed: ${r.detail}`);
    return `Verified: ${r.detail}`;
  });
}
