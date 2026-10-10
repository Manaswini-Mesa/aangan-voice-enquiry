import { costSummary } from "@/core/metrics";
import { formatIst } from "@/core/time";
import { RangeFilter } from "@/components/range-filter";
import { Badge, Card, EmptyState, Notice, PageHeader, Stat, Table, Td } from "@/components/ui";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { config } from "@/server/env";
import { LIST_PRICE_USD_PER_MTOK } from "@/server/providers/ai";
import { opsEvents, usageList } from "@/server/repo/queries";
import { getOverview, parseRange } from "@/server/services/metrics";

export const dynamic = "force-dynamic";
export const metadata = { title: "Costs & performance" };

function money(m: Record<string, number>, digits = 2) {
  const e = Object.entries(m);
  return e.length ? e.map(([c, v]) => `${c} ${v.toFixed(digits)}`).join(" + ") : "—";
}

export default async function CostsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await requireUser("costs:view");
  const cfg = config();
  const range = parseRange(sp, cfg.mode === "demo");
  const db = await getDb();
  const usage = await usageList(db, range.from, range.to, range.includeSimulated);
  const cs = costSummary(usage);
  const o = await getOverview(db, range);
  const events = await opsEvents(db, 40);
  const qualified = (o.totals.qualified ?? 0) + (o.totals.handed_off ?? 0);
  const estUsd = cs.estimated.USD;

  return (
    <>
      <PageHeader title="Costs & performance" description="What the system used, what it cost (where known), and what it produced. Actual charges and estimates are always shown separately." />
      <RangeFilter path="/costs" current={range.label} sim={range.includeSimulated} from={sp.from} to={sp.to} showSim />
      <div className="mb-4">
        <Notice tone="blue">
          <b>Where cost numbers come from.</b> VaaniVoice documents no usage or billing API, so voice cost is an <i>estimate</i> only if <code>VAANI_INR_PER_MINUTE_ESTIMATE</code> is set; otherwise “unavailable”. AI cost is an <i>estimate</i> from token counts × {cfg.anthropic.inputUsdPerMTok !== undefined ? "your configured rates" : `Anthropic list price for ${cfg.anthropic.model} (${LIST_PRICE_USD_PER_MTOK[cfg.anthropic.model] ? `$${LIST_PRICE_USD_PER_MTOK[cfg.anthropic.model].input}/$${LIST_PRICE_USD_PER_MTOK[cfg.anthropic.model].output} per million input/output tokens` : "not known"})`}. Email cost is an estimate only if <code>EMAIL_USD_PER_EMAIL_ESTIMATE</code> is set. Check provider invoices for actual charges.
        </Notice>
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Actual charges (provider-reported)" value={money(cs.actual)} hint="No provider currently reports charges via API" />
        <Stat label="Estimated cost" value={money(cs.estimated)} hint="Estimate — see note above" />
        <Stat label="Usage records without cost" value={cs.unavailableCount} />
        <Stat label="Estimated AI cost per qualified lead" value={estUsd !== undefined && qualified ? `USD ${(estUsd / qualified).toFixed(3)}` : "—"} hint={`${qualified} qualified in range`} />
      </div>
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card title="Usage by provider">
          {cs.byProvider.length === 0 ? (
            <EmptyState title="No usage recorded in this period">{cfg.anthropic.apiKey ? "" : "Demo/simulated calls make no AI or voice calls, so there is nothing to bill."}</EmptyState>
          ) : (
            <Table head={["Provider", "Usage", "Actual", "Estimated", "No cost info"]}>
              {cs.byProvider.map((p) => (
                <tr key={`${p.provider}-${p.kind}`}>
                  <Td>
                    {p.provider} <span className="text-xs text-stone-500">({p.kind.replace("_", " ")})</span>
                  </Td>
                  <Td className="tabular">
                    {p.quantity.toLocaleString("en-IN", { maximumFractionDigits: 2 })} {p.unit}
                  </Td>
                  <Td className="tabular">{money(p.actual)}</Td>
                  <Td className="tabular">{money(p.estimated, 4)}</Td>
                  <Td className="tabular">{p.unavailable}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="What it produced">
          <dl className="space-y-2 text-sm">
            {[
              ["Enquiries answered", o.total],
              ["Qualified & ready for designers", qualified],
              ["Sent to human review", o.totals.review ?? 0],
              ["Complaints escalated", o.complaints],
              ["Answered outside 10am–7pm", o.outsideHours],
              ["Answered within 5 minutes", o.response.pctWithin5Min === null ? "—" : `${o.response.pctWithin5Min}%`],
              ["Calls that dropped early", o.calls.disconnected],
              ["Failed notifications (now)", o.failedNotifications],
              ["Failed webhooks", o.ops.failedWebhooks],
            ].map(([k, v]) => (
              <div key={String(k)} className="flex justify-between">
                <dt className="text-stone-500">{k}</dt>
                <dd className="tabular font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
      <Card title="Recent operational events" description="Errors, fallbacks and warnings. Messages contain no personal data.">
        {events.length === 0 ? (
          <EmptyState title="No events" />
        ) : (
          <Table head={["When", "Level", "Source", "Event"]}>
            {events.map((e, i) => (
              <tr key={i}>
                <Td className="whitespace-nowrap text-xs">{formatIst(e.created_at)}</Td>
                <Td>
                  <Badge tone={e.level === "error" ? "red" : e.level === "warn" ? "amber" : "neutral"}>{e.level}</Badge>
                </Td>
                <Td className="text-xs">{e.source}</Td>
                <Td className="text-xs">
                  <span className="font-mono">{e.code}</span> — {e.message}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
