import Link from "next/link";
import { Flash } from "@/components/flash";
import { RangeFilter } from "@/components/range-filter";
import { Card, EmptyState, Notice, PageHeader, Stat } from "@/components/ui";
import { can } from "@/server/auth/permissions";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { config } from "@/server/env";
import { dailyEnquiries, getOverview, parseRange } from "@/server/services/metrics";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };

function fmtMoney(m: Record<string, number>): string {
  const e = Object.entries(m);
  if (!e.length) return "—";
  return e.map(([c, v]) => `${c === "INR" ? "₹" : c === "USD" ? "$" : `${c} `}${v.toFixed(2)}`).join(" + ");
}

function fmtDuration(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const cfg = config();
  const demo = cfg.mode === "demo";
  if (!can(user.role, "leads:view_all")) {
    return (
      <>
        <PageHeader title={`Welcome, ${user.name}`} description="Your assigned enquiries and follow-ups." />
        <Notice tone="blue">
          Designers see only enquiries assigned to them. Open <Link className="underline" href="/enquiries">Enquiries</Link> or{" "}
          <Link className="underline" href="/workspace">Handoffs &amp; follow-ups</Link>.
        </Notice>
      </>
    );
  }
  const range = parseRange(sp, demo);
  const db = await getDb();
  const o = await getOverview(db, range);
  const days = await dailyEnquiries(db, range);
  const t = (k: string) => o.totals[k] ?? 0;
  const max = Math.max(1, ...days.map((d) => d.total));
  const qualified = t("qualified") + t("handed_off");

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          <>
            All figures are calculated from records stored by this system{range.includeSimulated ? ", including simulated calls" : " (simulated calls excluded)"}. Work queues show the current state regardless of date range.
          </>
        }
      />
      <Flash sp={sp} />
      {sp.denied && (
        <div className="mb-4">
          <Notice tone="red">You don’t have access to that page.</Notice>
        </div>
      )}
      <RangeFilter path="/" current={range.label} sim={range.includeSimulated} from={sp.from} to={sp.to} showSim />

      {o.total === 0 ? (
        <EmptyState title="No enquiries in this period">
          {demo ? "Try a wider date range, or place a test call in the Call simulator." : "Once calls arrive through VaaniVoice (or simulated test calls are placed), metrics appear here."}
        </EmptyState>
      ) : null}

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">Enquiries</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Total enquiries" value={o.total} href="/enquiries" />
        <Stat label="Qualified" value={qualified} hint={o.total ? `${Math.round((qualified / o.total) * 100)}% of total` : undefined} href="/enquiries?status=qualified" />
        <Stat label="Declined / not qualified" value={t("declined") + t("not_qualified")} href="/enquiries?status=declined" />
        <Stat label="Incomplete" value={t("incomplete")} href="/enquiries?status=incomplete" tone={t("incomplete") ? "warn" : undefined} />
        <Stat label="Outside 10am–7pm" value={o.outsideHours} hint={o.total ? `${Math.round((o.outsideHours / o.total) * 100)}% of enquiries` : undefined} />
        <Stat label="Existing-client complaints" value={o.complaints} href="/complaints" tone={o.complaints ? "bad" : undefined} />
      </div>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">Work queues (now)</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
        <Stat label="Awaiting human review" value={o.awaitingReview} href="/review" tone={o.awaitingReview ? "warn" : undefined} />
        <Stat label="Pending designer handoffs" value={o.pendingHandoffs} href="/workspace" />
        <Stat label="Open follow-ups" value={o.openFollowUps} href="/workspace" />
        <Stat label="Overdue follow-ups" value={o.overdueFollowUps} href="/workspace" tone={o.overdueFollowUps ? "bad" : undefined} />
        <Stat label="Notifications needing attention" value={o.failedNotifications} hint="failed, unconfigured or pending" href="/workspace#notifications" tone={o.failedNotifications ? "bad" : undefined} />
      </div>

      <div className="mb-6 grid gap-4 xl:grid-cols-3">
        <Card title="Enquiries per day" description="Bar height = enquiries received that day (IST). Hover a bar for qualified count." className="xl:col-span-2">
          {days.length === 0 ? (
            <EmptyState title="No data for this range" />
          ) : (
            <>
              <div className="flex h-44 items-end gap-[2px] border-b border-stone-200" role="img" aria-label={`Daily enquiries, ${days.length} days, peak ${max}`}>
                {days.map((d) => (
                  <div key={d.day} className="group relative flex h-full flex-1 items-end" title={`${d.day}: ${d.total} enquiries, ${d.qualified} qualified`}>
                    <div className="w-full rounded-t-[4px] bg-brand-500 group-hover:bg-brand-700" style={{ height: `${(d.total / max) * 100}%`, minHeight: 2 }} />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-xs text-stone-500">
                <span>{days[0].day}</span>
                <span>peak {max}/day</span>
                <span>{days[days.length - 1].day}</span>
              </div>
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-xs text-brand-700">Show as table</summary>
                <table className="mt-2 w-full text-xs">
                  <thead>
                    <tr className="text-left text-stone-500">
                      <th className="py-1">Day</th>
                      <th>Enquiries</th>
                      <th>Qualified</th>
                    </tr>
                  </thead>
                  <tbody className="tabular">
                    {days.map((d) => (
                      <tr key={d.day} className="border-t border-stone-100">
                        <td className="py-1">{d.day}</td>
                        <td>{d.total}</td>
                        <td>{d.qualified}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>
          )}
        </Card>
        <Card title="Response performance" description="New enquiries only. “Response” = the AI receptionist answering the call.">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-stone-500">Answered within 5 minutes</dt>
              <dd className="tabular font-semibold">{o.response.pctWithin5Min === null ? "—" : `${o.response.pctWithin5Min}%`}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Median time to answer</dt>
              <dd className="tabular font-semibold">{fmtDuration(o.response.medianSeconds)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Calls ({o.calls.live} live · {o.calls.simulated} simulated)</dt>
              <dd className="tabular font-semibold">{o.calls.count}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Average call length</dt>
              <dd className="tabular font-semibold">{fmtDuration(o.calls.avgDurationSec)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Calls that dropped before finishing</dt>
              <dd className="tabular font-semibold">{o.calls.disconnected}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-stone-500">Calls the provider never delivered to this system (e.g. outages) cannot be counted here.</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Operational health" description="In the selected range">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-stone-500">Failed webhook deliveries</dt>
              <dd className="tabular font-semibold">{o.ops.failedWebhooks}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Errors logged</dt>
              <dd className="tabular font-semibold">{o.ops.errors}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Incomplete enquiries</dt>
              <dd className="tabular font-semibold">{t("incomplete")}</dd>
            </div>
          </dl>
        </Card>
        <Card title="Usage & cost" description="Actual charges and estimates are never added together." actions={can(user.role, "costs:view") ? <Link className="text-xs text-brand-700 hover:underline" href="/costs">Details</Link> : undefined}>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-stone-500">AI tokens</dt>
              <dd className="tabular font-semibold">{o.llmTokens.toLocaleString("en-IN")}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Voice minutes</dt>
              <dd className="tabular font-semibold">{o.voiceMinutes.toFixed(1)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Emails accepted by provider</dt>
              <dd className="tabular font-semibold">{o.emailsSent}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Actual charges (provider-reported)</dt>
              <dd className="tabular font-semibold">{fmtMoney(o.costs.actual)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-stone-500">Estimated cost</dt>
              <dd className="tabular font-semibold">{fmtMoney(o.costs.estimated)}</dd>
            </div>
          </dl>
          {o.costs.unavailableCount > 0 && <p className="mt-2 text-xs text-stone-500">{o.costs.unavailableCount} usage record(s) have no cost information available.</p>}
        </Card>
      </div>
    </>
  );
}
