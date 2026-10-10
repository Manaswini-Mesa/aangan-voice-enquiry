// Appointment request lifecycle. A request is never "confirmed" by the caller stating a
// preference or by the system storing it — only by a calendar provider's confirmation or an
// authenticated staff member recording that they confirmed it with the client.

export type AppointmentStatus = "pending_confirmation" | "confirmed" | "rejected" | "cancelled" | "reschedule_requested";

const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  pending_confirmation: ["confirmed", "rejected", "cancelled", "reschedule_requested"],
  reschedule_requested: ["confirmed", "rejected", "cancelled", "pending_confirmation"],
  confirmed: ["cancelled", "reschedule_requested"],
  rejected: ["pending_confirmation"],
  cancelled: ["pending_confirmation"],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface ConfirmationEvidence {
  /** "calendar" when a real calendar integration returned a booking reference. */
  by: "calendar" | "staff";
  reference?: string;
  staffUserId?: string;
}

export function validateTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
  evidence?: ConfirmationEvidence,
): { ok: true } | { ok: false; error: string } {
  if (!canTransition(from, to)) return { ok: false, error: `Cannot move an appointment from ${from} to ${to}.` };
  if (to === "confirmed") {
    if (!evidence) return { ok: false, error: "Confirmation requires a calendar reference or a staff member's confirmation." };
    if (evidence.by === "calendar" && !evidence.reference) return { ok: false, error: "Calendar confirmation requires a booking reference." };
    if (evidence.by === "staff" && !evidence.staffUserId) return { ok: false, error: "Staff confirmation requires an authenticated user." };
  }
  return { ok: true };
}

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  pending_confirmation: "Requested — needs human confirmation",
  confirmed: "Confirmed",
  rejected: "Rejected",
  cancelled: "Cancelled",
  reschedule_requested: "Reschedule requested",
};
