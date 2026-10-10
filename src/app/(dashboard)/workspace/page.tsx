import Link from "next/link";
import { STATUS_LABEL, type AppointmentStatus } from "@/core/appointments";
import { formatIst } from "@/core/time";
import { assignDesignerAction, completeFollowUpAction, retryNotificationAction } from "../../actions";
import { Flash } from "@/components/flash";
import { Badge, Card, EmptyState, PageHeader, SimBadge, Table, Td, btn, cx, input } from "@/components/ui";
import { can } from "@/server/auth/permissions";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { workspace } from "@/server/repo/queries";
import { listDesigners } from "@/server/repo/users";

export const dynamic = "force-dynamic";
export const metadata = { title: "Handoffs & follow-ups" };

export default async function WorkspacePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await getDb();
  const w = await workspace(db, user);
  const designers = can(user.role, "handoff:assign") ? await listDesigners(db) : [];
  const now = new Date();
  const overdue = w.followUps.filter((f) => f.due_at && new Date(f.due_at) < now);
  const upcoming = w.followUps.filter((f) => !(f.due_at && new Date(f.due_at) < now));

  return (
    <>
      <PageHeader title="Handoffs & follow-ups" description="Everything that needs a person to act. Failed actions stay here until they succeed." />
      <Flash sp={sp} />
      <div className="space-y-4">
        <Card title={`Designer handoffs (${w.handoffs.length})`} description="Qualified leads waiting for a designer, and assigned leads not yet contacted.">
          {w.handoffs.length === 0 ? (
            <EmptyState title="No pending handoffs" />
          ) : (
            <Table head={["Lead", "Project", "Status", "Due", can(user.role, "handoff:assign") ? "Assign" : "Designer"]}>
              {w.handoffs.map((h) => (
                <tr key={h.id}>
                  <Td>
                    <Link className="font-medium text-brand-700 hover:underline" href={`/enquiries/${h.lead_id}`}>
                      {h.ref}
                    </Link>{" "}
                    <SimBadge simulated={h.is_simulated} />
                    <div className="text-xs text-stone-500">{h.caller_name ?? "Name not given"}</div>
                  </Td>
                  <Td className="max-w-xs text-xs">
                    {h.scope_summary}
                    {h.locality && <div className="text-stone-500">{h.locality}</div>}
                  </Td>
                  <Td>
                    <Badge tone={h.status === "pending_assignment" ? "amber" : "green"}>{h.status === "pending_assignment" ? "Unassigned" : "Assigned"}</Badge>
                  </Td>
                  <Td className={cx("whitespace-nowrap text-xs", h.due_at && new Date(h.due_at) < now ? "text-rose-700" : "")}>{formatIst(h.due_at)}</Td>
                  <Td>
                    {can(user.role, "handoff:assign") ? (
                      <form action={assignDesignerAction} className="flex gap-2">
                        <input type="hidden" name="leadId" value={h.lead_id} />
                        <input type="hidden" name="returnTo" value="/workspace" />
                        <select name="designerId" required defaultValue="" aria-label="Designer" className={cx(input, "py-1.5")}>
                          <option value="" disabled>
                            {h.designer_name ?? "Choose…"}
                          </option>
                          {designers.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                        <button className={btn.secondary}>Save</button>
                      </form>
                    ) : (
                      h.designer_name
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title={`Overdue follow-ups (${overdue.length})`}>
          {overdue.length === 0 ? <EmptyState title="Nothing overdue" /> : <FollowUpTable rows={overdue} canEdit={can(user.role, "followups:manage")} />}
        </Card>
        <Card title={`Upcoming follow-ups (${upcoming.length})`}>
          {upcoming.length === 0 ? <EmptyState title="No open follow-ups" /> : <FollowUpTable rows={upcoming} canEdit={can(user.role, "followups:manage")} />}
        </Card>

        <Card title={`Consultation requests awaiting confirmation (${w.appointments.length})`} description="No calendar is connected, so each request must be confirmed with the client by a person.">
          {w.appointments.length === 0 ? (
            <EmptyState title="No pending consultation requests" />
          ) : (
            <Table head={["Lead", "Caller preference", "Status", "Updated"]}>
              {w.appointments.map((a) => (
                <tr key={a.lead_id}>
                  <Td>
                    <Link className="font-medium text-brand-700 hover:underline" href={`/enquiries/${a.lead_id}`}>
                      {a.ref}
                    </Link>{" "}
                    <SimBadge simulated={a.is_simulated} />
                  </Td>
                  <Td>{a.preferred_text ?? "No time given"}</Td>
                  <Td>
                    <Badge tone="amber">{STATUS_LABEL[a.status as AppointmentStatus]}</Badge>
                  </Td>
                  <Td className="text-xs">{formatIst(a.updated_at)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {can(user.role, "notifications:retry") && (
          <div id="notifications">
            <Card title={`Notifications needing attention (${w.notifications.length})`} description="Failed, unconfigured or still-pending emails. Records are saved regardless; retrying never sends a delivered email twice.">
              {w.notifications.length === 0 ? (
                <EmptyState title="No notifications need attention">Every notification is sent or (in demo mode) simulated.</EmptyState>
              ) : (
                <Table head={["Lead", "Type", "Status", "Attempts", "Last error", ""]}>
                  {w.notifications.map((n) => (
                    <tr key={n.id}>
                      <Td>{n.lead_id ? <Link className="text-brand-700 hover:underline" href={`/enquiries/${n.lead_id}`}>{n.ref}</Link> : "—"}</Td>
                      <Td className="capitalize">{n.kind.replace("_", " ")}</Td>
                      <Td>
                        <Badge tone={n.status === "failed" ? "red" : n.status === "pending" ? "blue" : "amber"}>{n.status.replace("_", " ")}</Badge>
                      </Td>
                      <Td className="tabular">{n.attempts}</Td>
                      <Td className="max-w-xs text-xs text-rose-700">{n.last_error}</Td>
                      <Td>
                        <form action={retryNotificationAction}>
                          <input type="hidden" name="notificationId" value={n.id} />
                          <input type="hidden" name="returnTo" value="/workspace#notifications" />
                          <button className={btn.secondary}>Retry</button>
                        </form>
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        )}
      </div>
    </>
  );
}

function FollowUpTable({ rows, canEdit }: { rows: Array<{ id: string; lead_id: string; kind: string; due_at: string | null; notes: string | null; ref: string; caller_name: string | null; is_simulated: boolean }>; canEdit: boolean }) {
  return (
    <Table head={["Lead", "Task", "Due", canEdit ? "Complete" : ""]}>
      {rows.map((f) => (
        <tr key={f.id}>
          <Td>
            <Link className="font-medium text-brand-700 hover:underline" href={`/enquiries/${f.lead_id}`}>
              {f.ref}
            </Link>{" "}
            <SimBadge simulated={f.is_simulated} />
            <div className="text-xs text-stone-500">{f.caller_name ?? "Name not given"}</div>
          </Td>
          <Td className="max-w-sm">
            <div className="font-medium capitalize">{f.kind.replace(/_/g, " ")}</div>
            <div className="text-xs text-stone-600">{f.notes}</div>
          </Td>
          <Td className="whitespace-nowrap text-xs">{formatIst(f.due_at)}</Td>
          <Td>
            {canEdit && (
              <form action={completeFollowUpAction} className="flex gap-2">
                <input type="hidden" name="followUpId" value={f.id} />
                <input type="hidden" name="returnTo" value="/workspace" />
                <input name="outcome" placeholder="Outcome" aria-label="Outcome" className={cx(input, "py-1.5")} />
                <button className={btn.secondary}>Done</button>
              </form>
            )}
          </Td>
        </tr>
      ))}
    </Table>
  );
}
