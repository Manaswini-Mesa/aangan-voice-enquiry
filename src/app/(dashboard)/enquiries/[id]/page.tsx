import Link from "next/link";
import { notFound } from "next/navigation";
import { STATUS_LABEL, type AppointmentStatus } from "@/core/appointments";
import { formatIst } from "@/core/time";
import {
  addFollowUpAction,
  appointmentAction,
  assignDesignerAction,
  closeLeadAction,
  complaintAction,
  completeFollowUpAction,
  retryNotificationAction,
  reviewDecisionAction,
} from "../../../actions";
import { Flash } from "@/components/flash";
import { Badge, Card, CriterionBadge, EmptyState, Field, Notice, PageHeader, SimBadge, StatusBadge, btn, cx, input } from "@/components/ui";
import { can } from "@/server/auth/permissions";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { getLeadDetail } from "@/server/repo/queries";
import { listDesigners } from "@/server/repo/users";

export const dynamic = "force-dynamic";
export const metadata = { title: "Enquiry" };

function showValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("raw" in o) return String(o.canonical ?? o.raw) + (o.alternatives ? ` (also mentioned: ${(o.alternatives as string[]).join(", ")})` : "");
    if ("min" in o || "max" in o) return `₹${Number(o.min ?? o.max).toLocaleString("en-IN")}${o.max && o.min !== o.max ? ` – ₹${Number(o.max).toLocaleString("en-IN")}` : ""}`;
    return JSON.stringify(v);
  }
  return String(v);
}

const SOURCE_LABEL: Record<string, string> = {
  caller_stated: "Caller said",
  ai_inferred: "AI inferred",
  provider_extracted: "Provider extracted",
  staff_entered: "Staff entered",
  system: "System (caller ID)",
};

const NOTIF_TONE: Record<string, "green" | "red" | "amber" | "neutral" | "blue"> = { sent: "green", failed: "red", not_configured: "amber", pending: "blue", simulated: "neutral" };
const NOTIF_LABEL: Record<string, string> = { sent: "Sent (accepted by provider)", failed: "Failed", not_configured: "Not configured", pending: "Pending", simulated: "Simulated — not sent" };

export default async function LeadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = await getDb();
  const d = await getLeadDetail(db, user, id);
  if (!d) notFound();
  const { lead } = d;
  const here = `/enquiries/${lead.id}`;
  const designers = can(user.role, "handoff:assign") ? await listDesigners(db) : [];
  const automated = d.assessments.find((a) => a.kind === "automated");
  const overrides = d.assessments.filter((a) => a.kind === "human_override");
  const currentFacts = d.facts.filter((f) => !f.superseded);
  const oldFacts = d.facts.filter((f) => f.superseded);
  const conflicts = currentFacts.filter((f) => f.validation === "conflict" || f.validation === "unverified");
  const canSeeTranscript = can(user.role, "leads:view_all") || lead.assigned_designer_id === user.id;
  const today = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/enquiries" className="text-brand-700 hover:underline">
          ← Enquiries
        </Link>
      </div>
      <PageHeader
        title={`${lead.ref} · ${lead.caller_name ?? "Name not given"}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={lead.status} />
            <SimBadge simulated={lead.is_simulated} />
            {lead.disposition && <Badge title="Automated disposition from the rules engine">Engine: {lead.disposition.replace(/_/g, " ").toLowerCase()}</Badge>}
            {lead.outside_hours && <Badge tone="blue">Outside business hours</Badge>}
            <span className="text-stone-500">Received {formatIst(lead.created_at)}</span>
          </span>
        }
        actions={
          can(user.role, "leads:edit") && lead.status !== "closed" ? (
            <form action={closeLeadAction} className="flex gap-2">
              <input type="hidden" name="leadId" value={lead.id} />
              <input type="hidden" name="returnTo" value={here} />
              <input name="reason" required placeholder="Reason for closing" aria-label="Reason for closing" className={cx(input, "w-48 py-1.5")} />
              <button className={btn.secondary}>Close enquiry</button>
            </form>
          ) : undefined
        }
      />
      <Flash sp={sp} />
      {lead.is_simulated && (
        <div className="mb-4">
          <Notice>This is a simulated/synthetic enquiry. It is not a real customer interaction.</Notice>
        </div>
      )}
      {d.duplicate && (
        <div className="mb-4">
          <Notice tone="blue">
            Same phone number as earlier enquiry{" "}
            <Link className="underline" href={`/enquiries/${d.duplicate.id}`}>
              {d.duplicate.ref}
            </Link>
            . Records are not merged automatically — check whether they are the same person.
          </Notice>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card title="Caller & project brief">
            <dl className="grid gap-x-8 md:grid-cols-2">
              <Field label="Caller">{lead.caller_name}</Field>
              <Field label="Phone">{lead.phone}</Field>
              <Field label="Email">{lead.email}</Field>
              <Field label="Enquiry type">{lead.enquiry_type.replace("_", " ")}</Field>
              <Field label="Category">{lead.project_category}</Field>
              <Field label="Property">{lead.property_type?.replace(/_/g, " ")}</Field>
              <Field label="Location">{lead.locality}</Field>
              <Field label="Area">{lead.area_sqft ? `${Number(lead.area_sqft)} sq ft` : null}</Field>
              <Field label="Scope">{lead.scope_summary}</Field>
              <Field label="Timeline">{lead.timeline_summary}</Field>
              <Field label="Budget">{lead.budget_text ? `${lead.budget_text} (volunteered)` : "Not discussed"}</Field>
              <Field label="Authority">{lead.authority}</Field>
              <Field label="Next action">{lead.next_action}</Field>
              <Field label="Due">{lead.next_action_due ? formatIst(lead.next_action_due) : null}</Field>
            </dl>
            {lead.summary && (
              <div className="mt-4 rounded-lg bg-stone-50 p-3 text-sm text-stone-700">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Summary</div>
                {lead.summary}
              </div>
            )}
          </Card>

          {lead.status === "review" && can(user.role, "review:decide") && (
            <Card title="Record review decision" description="Your decision is stored alongside — not instead of — the automated assessment. Rules for future calls are not changed.">
              <form action={reviewDecisionAction} className="space-y-3">
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="returnTo" value={here} />
                <fieldset className="flex flex-wrap gap-4 text-sm">
                  <legend className="sr-only">Decision</legend>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="decision" value="qualify" required /> Qualify &amp; hand off to a designer
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="decision" value="decline" /> Decline
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="decision" value="needs_more_info" /> Needs more information
                  </label>
                </fieldset>
                <label htmlFor="rationale" className="block text-xs font-medium text-stone-600">
                  Rationale (required, kept in the audit history)
                </label>
                <textarea id="rationale" name="rationale" required minLength={5} rows={3} className={input} />
                <button className={btn.primary}>Save decision</button>
              </form>
            </Card>
          )}

          <Card title="Qualification" description={automated ? `Latest automated assessment · rules ${automated.rule_version} · ${formatIst(automated.created_at)}` : undefined}>
            {!automated ? (
              <EmptyState title="Not assessed yet" />
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-stone-500">Automated disposition:</span>
                  <Badge tone="violet">{automated.disposition.replace(/_/g, " ")}</Badge>
                </div>
                <div className="divide-y divide-stone-100">
                  {automated.criteria
                    .filter((c) => c.applicable)
                    .map((c) => (
                      <div key={c.id} className="py-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium">{c.label}</span>
                          <CriterionBadge state={c.state} />
                        </div>
                        <p className="mt-1 text-sm text-stone-600">{c.reasons.join(" ")}</p>
                        {c.provisionalRule && <p className="mt-1 text-xs font-medium text-amber-800">⚠ {c.provisionalRule}</p>}
                        {c.evidence.length > 0 && (
                          <p className="mt-1 text-xs text-stone-500">
                            Evidence: {c.evidence.map((e) => `${e.fact}=${showValue(e.value)} (${SOURCE_LABEL[e.source] ?? e.source}, ${Math.round(e.confidence * 100)}%)`).join("; ")}
                          </p>
                        )}
                        <p className="mt-0.5 font-mono text-[11px] text-stone-400">{c.ruleCode}</p>
                      </div>
                    ))}
                </div>
                {automated.review_reasons.length > 0 && (
                  <div className="mt-3">
                    <Notice tone="blue">
                      <b>Review reasons:</b>
                      <ul className="ml-4 list-disc">
                        {automated.review_reasons.map((r, i) => (
                          <li key={i}>
                            {r.message} {r.mandatory && <Badge tone="violet">mandatory</Badge>}
                          </li>
                        ))}
                      </ul>
                    </Notice>
                  </div>
                )}
                <details className="mt-3 text-xs text-stone-600">
                  <summary className="cursor-pointer text-brand-700">Precedence trace</summary>
                  <ol className="ml-4 mt-1 list-decimal">
                    {automated.precedence_trace.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ol>
                </details>
                {overrides.length > 0 && (
                  <div className="mt-4 border-t border-stone-100 pt-3">
                    <h3 className="mb-2 text-sm font-semibold">Human decisions</h3>
                    {overrides.map((o) => (
                      <div key={o.id} className="mb-2 rounded-lg bg-violet-50 p-3 text-sm">
                        <b>{o.disposition.replace(/_/g, " ")}</b> by {o.created_by_name ?? "staff"} · {formatIst(o.created_at)}
                        <p className="mt-1 text-stone-700">“{o.rationale}”</p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </Card>

          <Card title="Extracted facts" description="Where each fact came from and how confident the system is.">
            {conflicts.length > 0 && (
              <div className="mb-3">
                <Notice>
                  {conflicts.length} fact(s) are unverified or conflicting: {conflicts.map((c) => c.key).join(", ")}.
                </Notice>
              </div>
            )}
            {currentFacts.length === 0 ? (
              <EmptyState title="No facts captured" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-stone-200 text-left text-xs uppercase text-stone-500">
                      <th className="py-2 pr-3">Fact</th>
                      <th className="pr-3">Value</th>
                      <th className="pr-3">Source</th>
                      <th className="pr-3">Confidence</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {currentFacts.map((f) => (
                      <tr key={f.key + f.created_at}>
                        <td className="py-1.5 pr-3 font-mono text-xs">{f.key}</td>
                        <td className="pr-3" title={f.evidence ?? ""}>
                          {showValue(f.value)}
                        </td>
                        <td className="pr-3 text-xs">{SOURCE_LABEL[f.source] ?? f.source}</td>
                        <td className="tabular pr-3 text-xs">{Math.round(Number(f.confidence) * 100)}%</td>
                        <td>{f.validation === "valid" ? <Badge tone="green">valid</Badge> : <Badge tone="amber">{f.validation}</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {oldFacts.length > 0 && (
              <details className="mt-2 text-xs text-stone-600">
                <summary className="cursor-pointer text-brand-700">{oldFacts.length} earlier/superseded value(s)</summary>
                <ul className="mt-1 space-y-0.5">
                  {oldFacts.map((f, i) => (
                    <li key={i}>
                      <span className="font-mono">{f.key}</span>: {showValue(f.value)} ({SOURCE_LABEL[f.source] ?? f.source}, {formatIst(f.created_at)})
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>

          <Card title={`Calls (${d.calls.length})`}>
            {d.calls.length === 0 && <EmptyState title="No calls" />}
            <div className="space-y-5">
              {d.calls.map((c) => {
                const segs = d.segments.filter((s) => s.call_id === c.id);
                return (
                  <div key={c.id} className="rounded-lg border border-stone-200">
                    <div className="flex flex-wrap items-center gap-2 border-b border-stone-100 bg-stone-50 px-3 py-2 text-xs">
                      <SimBadge simulated={c.mode === "simulated"} />
                      <Badge tone={c.status === "completed" ? "green" : c.status === "disconnected" ? "amber" : c.status === "failed" ? "red" : "blue"}>{c.status}</Badge>
                      <span>{formatIst(c.started_at)}</span>
                      <span>· {c.duration_sec ? `${Math.round(Number(c.duration_sec))}s` : "duration unknown"}</span>
                      <span>· {c.provider}</span>
                      {c.end_reason && <span>· ended: {c.end_reason}</span>}
                      <span className="ml-auto">{c.recording_available ? "Recording reference stored" : "No recording stored"}</span>
                    </div>
                    {c.summary && (
                      <p className="px-3 pt-2 text-sm text-stone-700">
                        <span className="text-xs font-semibold text-stone-500">Summary ({c.summary_source === "ai" ? "AI-written" : "rule-based"}): </span>
                        {c.summary}
                      </p>
                    )}
                    {c.provider_summary && (
                      <p className="px-3 pt-1 text-sm text-stone-600">
                        <span className="text-xs font-semibold text-stone-500">Provider summary: </span>
                        {c.provider_summary}
                      </p>
                    )}
                    {canSeeTranscript ? (
                      segs.length ? (
                        <details className="px-3 py-2" open={d.calls.length === 1}>
                          <summary className="cursor-pointer text-xs text-brand-700">Transcript ({segs.length} lines)</summary>
                          <ol className="mt-2 space-y-1.5 text-sm">
                            {segs.map((s) => (
                              <li key={s.id} className={cx("rounded-lg px-3 py-1.5", s.speaker === "caller" ? "bg-sky-50" : s.speaker === "agent" ? "bg-stone-50" : "bg-amber-50 text-xs")}>
                                <span className="mr-2 text-xs font-semibold uppercase text-stone-500">{s.speaker === "agent" ? "Assistant" : s.speaker}</span>
                                {s.text}
                                {s.confidence !== null && Number(s.confidence) < 0.8 && <span className="ml-2 text-xs text-amber-700">(STT {Math.round(Number(s.confidence) * 100)}%)</span>}
                              </li>
                            ))}
                          </ol>
                        </details>
                      ) : (
                        <p className="px-3 py-2 text-sm text-stone-500">Transcript not available for this call.</p>
                      )
                    ) : (
                      <p className="px-3 py-2 text-sm text-stone-500">You don’t have access to this transcript.</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          {d.complaint && (
            <Card title="Complaint escalation">
              <p className="text-sm">{d.complaint.summary}</p>
              <dl className="mt-2">
                <Field label="Status">
                  <Badge tone={d.complaint.status === "resolved" ? "green" : "red"}>{d.complaint.status}</Badge>
                </Field>
                <Field label="Designer named">{d.complaint.designer_name}</Field>
                <Field label="Raised">{formatIst(d.complaint.created_at)}</Field>
              </dl>
              {d.complaint.status !== "resolved" && can(user.role, "complaints:manage") && (
                <form action={complaintAction} className="mt-3 space-y-2">
                  <input type="hidden" name="complaintId" value={d.complaint.id} />
                  <input type="hidden" name="returnTo" value={here} />
                  <input name="note" placeholder="Note (e.g. who called back)" aria-label="Note" className={input} />
                  <div className="flex gap-2">
                    {d.complaint.status === "open" && (
                      <button name="status" value="acknowledged" className={btn.secondary}>
                        Mark acknowledged
                      </button>
                    )}
                    <button name="status" value="resolved" className={btn.primary}>
                      Mark resolved
                    </button>
                  </div>
                </form>
              )}
            </Card>
          )}

          <Card title="Designer handoff">
            {!d.handoff ? (
              <p className="text-sm text-stone-500">No handoff — only qualified enquiries are handed to a designer.</p>
            ) : (
              <>
                <dl>
                  <Field label="Status">
                    <Badge tone={d.handoff.status === "pending_assignment" ? "amber" : "green"}>{d.handoff.status.replace("_", " ")}</Badge>
                  </Field>
                  <Field label="Designer">{d.handoff.designer_name}</Field>
                  <Field label="Created">{formatIst(d.handoff.created_at)}</Field>
                  <Field label="Assigned">{d.handoff.assigned_at ? formatIst(d.handoff.assigned_at) : null}</Field>
                </dl>
                {can(user.role, "handoff:assign") && (
                  <form action={assignDesignerAction} className="mt-3 flex gap-2">
                    <input type="hidden" name="leadId" value={lead.id} />
                    <input type="hidden" name="returnTo" value={here} />
                    <label htmlFor="designerId" className="sr-only">
                      Designer
                    </label>
                    <select id="designerId" name="designerId" required className={input} defaultValue="">
                      <option value="" disabled>
                        Choose designer…
                      </option>
                      {designers.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                    <button className={btn.primary}>{d.handoff.designer_name ? "Reassign" : "Assign"}</button>
                  </form>
                )}
              </>
            )}
          </Card>

          <Card title="Consultation request">
            {!d.appointment ? (
              <p className="text-sm text-stone-500">No consultation requested.</p>
            ) : (
              <>
                <dl>
                  <Field label="Status">
                    <Badge tone={d.appointment.status === "confirmed" ? "green" : "amber"}>{STATUS_LABEL[d.appointment.status as AppointmentStatus]}</Badge>
                  </Field>
                  <Field label="Caller preference">{d.appointment.preferred_text ?? "Not given"}</Field>
                  <Field label="Calendar">{d.appointment.provider === "manual" ? "No calendar integration" : d.appointment.provider}</Field>
                  <Field label="Notes">{d.appointment.notes}</Field>
                </dl>
                {can(user.role, "appointments:manage") && (
                  <form action={appointmentAction} className="mt-3 space-y-2">
                    <input type="hidden" name="leadId" value={lead.id} />
                    <input type="hidden" name="returnTo" value={here} />
                    <input name="note" placeholder="e.g. Confirmed Sat 4 Oct 11am by phone" aria-label="Note" className={input} />
                    <div className="flex flex-wrap gap-2">
                      {d.appointment.status !== "confirmed" && (
                        <button name="status" value="confirmed" className={btn.primary}>
                          I confirmed it with the client
                        </button>
                      )}
                      <button name="status" value="reschedule_requested" className={btn.secondary}>
                        Reschedule
                      </button>
                      <button name="status" value="cancelled" className={btn.secondary}>
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </Card>

          <Card title="Follow-ups">
            {d.followUps.length === 0 && <p className="text-sm text-stone-500">None.</p>}
            <ul className="space-y-2">
              {d.followUps.map((f) => (
                <li key={f.id} className="rounded-lg border border-stone-200 p-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{f.kind.replace(/_/g, " ")}</span>
                    <Badge tone={f.status === "open" ? (f.due_at && new Date(f.due_at) < new Date() ? "red" : "amber") : "green"}>
                      {f.status === "open" && f.due_at && new Date(f.due_at) < new Date() ? "overdue" : f.status}
                    </Badge>
                  </div>
                  {f.notes && <p className="text-xs text-stone-600">{f.notes}</p>}
                  <p className="text-xs text-stone-500">Due {formatIst(f.due_at)}</p>
                  {f.outcome && <p className="text-xs text-stone-500">Outcome: {f.outcome}</p>}
                  {f.status === "open" && can(user.role, "followups:manage") && (
                    <form action={completeFollowUpAction} className="mt-2 flex gap-2">
                      <input type="hidden" name="followUpId" value={f.id} />
                      <input type="hidden" name="returnTo" value={here} />
                      <input name="outcome" placeholder="Outcome" aria-label="Outcome" className={cx(input, "py-1")} />
                      <button className={btn.secondary}>Done</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            {can(user.role, "followups:manage") && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-brand-700">Add follow-up</summary>
                <form action={addFollowUpAction} className="mt-2 space-y-2">
                  <input type="hidden" name="leadId" value={lead.id} />
                  <input type="hidden" name="returnTo" value={here} />
                  <select name="kind" className={input} aria-label="Kind">
                    <option value="callback">Callback</option>
                    <option value="clarification">Clarification</option>
                    <option value="re_engage">Re-engage later</option>
                    <option value="consultation_confirm">Confirm consultation</option>
                  </select>
                  <div className="flex gap-2">
                    <input type="date" name="dueDate" required defaultValue={today} className={input} aria-label="Due date" />
                    <input type="time" name="dueTime" defaultValue="11:00" className={input} aria-label="Due time" />
                  </div>
                  <input name="notes" placeholder="Notes" aria-label="Notes" className={input} />
                  <button className={btn.secondary}>Add</button>
                </form>
              </details>
            )}
          </Card>

          <Card title="Notifications">
            {d.notifications.length === 0 && <p className="text-sm text-stone-500">None.</p>}
            <ul className="space-y-2">
              {d.notifications.map((n) => (
                <li key={n.id} className="rounded-lg border border-stone-200 p-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium capitalize">{n.kind.replace("_", " ")} email</span>
                    <Badge tone={NOTIF_TONE[n.status]}>{NOTIF_LABEL[n.status]}</Badge>
                  </div>
                  <p className="text-xs text-stone-500">
                    {n.recipients.length} recipient(s) · {n.attempts} attempt(s){n.sent_at ? ` · sent ${formatIst(n.sent_at)}` : ""}
                  </p>
                  {n.last_error && <p className="text-xs text-rose-700">{n.last_error}</p>}
                  {["failed", "not_configured", "pending"].includes(n.status) && can(user.role, "notifications:retry") && (
                    <form action={retryNotificationAction} className="mt-2">
                      <input type="hidden" name="notificationId" value={n.id} />
                      <input type="hidden" name="returnTo" value={here} />
                      <button className={btn.secondary}>Retry</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Usage for this enquiry">
            {d.usage.length === 0 ? (
              <p className="text-sm text-stone-500">No usage recorded.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {d.usage.map((u, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span>
                      {u.provider} · {Number(u.quantity).toLocaleString("en-IN")} {u.unit}
                    </span>
                    <span className="text-stone-500">{u.cost_type === "unavailable" ? "cost unavailable" : `${u.cost_type}: ${u.cost_currency} ${Number(u.cost_amount).toFixed(4)}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Audit history">
            <ol className="max-h-96 space-y-2 overflow-y-auto text-xs">
              {d.audit.map((a, i) => (
                <li key={i} className="border-l-2 border-stone-200 pl-2">
                  <div className="font-medium text-stone-800">{a.action}</div>
                  <div className="text-stone-500">
                    {a.actor_label} · {formatIst(a.created_at)}
                  </div>
                  {a.after != null && <div className="truncate text-stone-500" title={JSON.stringify(a.after)}>{JSON.stringify(a.after)}</div>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
