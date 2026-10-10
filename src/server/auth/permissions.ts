import type { Role } from "./session-token";

// Role-based permissions. Designers only see leads assigned to them.

export type Permission =
  | "leads:view_all"
  | "leads:view_assigned"
  | "leads:edit"
  | "review:decide"
  | "handoff:assign"
  | "complaints:manage"
  | "notifications:retry"
  | "appointments:manage"
  | "followups:manage"
  | "simulator:use"
  | "integrations:view"
  | "integrations:verify"
  | "costs:view"
  | "users:manage";

const MATRIX: Record<Role, Permission[]> = {
  admin: [
    "leads:view_all", "leads:view_assigned", "leads:edit", "review:decide", "handoff:assign", "complaints:manage",
    "notifications:retry", "appointments:manage", "followups:manage", "simulator:use", "integrations:view",
    "integrations:verify", "costs:view", "users:manage",
  ],
  manager: [
    "leads:view_all", "leads:view_assigned", "leads:edit", "review:decide", "handoff:assign", "complaints:manage",
    "notifications:retry", "appointments:manage", "followups:manage", "simulator:use", "integrations:view", "costs:view",
  ],
  designer: ["leads:view_assigned", "appointments:manage", "followups:manage"],
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

/** Whether a user may see a specific lead (and its transcript / contact details). */
export function canViewLead(user: { id: string; role: Role }, lead: { assigned_designer_id: string | null }): boolean {
  if (can(user.role, "leads:view_all")) return true;
  return can(user.role, "leads:view_assigned") && lead.assigned_designer_id === user.id;
}
