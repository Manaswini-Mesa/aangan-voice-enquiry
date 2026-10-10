import { formatIst } from "@/core/time";
import { ruleVersion } from "@/core/rules";
import { verifyIntegrationAction } from "../../actions";
import { Flash } from "@/components/flash";
import { Badge, Card, PageHeader, Table, Td, btn, type Tone } from "@/components/ui";
import { can } from "@/server/auth/permissions";
import { requireUser } from "@/server/auth/session";
import { getDb, type Db } from "@/server/db/client";
import { config } from "@/server/env";
import { webhookEvents } from "@/server/repo/queries";
import { integrationStatuses, type IntegrationState } from "@/server/services/integrations";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrations" };

const STATE: Record<IntegrationState, { label: string; tone: Tone }> = {
  verified: { label: "Connected & verified", tone: "green" },
  configured_unverified: { label: "Configured, not verified", tone: "amber" },
  simulated: { label: "Simulated", tone: "neutral" },
  unconfigured: { label: "Not configured", tone: "red" },
  error: { label: "Error", tone: "red" },
  manual: { label: "Manual (no integration)", tone: "blue" },
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser("integrations:view");
  const cfg = config();
  let db: Db | null = null;
  let dbError: string | undefined;
  try {
    db = await getDb();
  } catch (err) {
    dbError = (err as Error).message;
  }
  const statuses = await integrationStatuses(db, dbError);
  const hooks = db ? await webhookEvents(db, 20) : [];
  const verify = can(user.role, "integrations:verify");
  const rules = cfg.rules;

  return (
    <>
      <PageHeader title="Integrations" description="Actual state of each external dependency. Secret values are never displayed — only whether each variable is set." />
      <Flash sp={sp} />
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        {statuses.map((s) => (
          <Card
            key={s.key}
            title={s.name}
            actions={<Badge tone={STATE[s.state].tone}>{STATE[s.state].label}</Badge>}
          >
            <p className="text-sm text-stone-700">{s.detail}</p>
            {s.extra && (
              <ul className="mt-2 list-disc pl-5 text-xs text-stone-600">
                {s.extra.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            {s.envVars.length > 0 && (
              <p className="mt-3 text-xs text-stone-500">
                Variables:{" "}
                {s.envVars.map((v) => (
                  <code key={v} className={`mr-1.5 rounded px-1 ${s.missing.includes(v) ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>
                    {v} {s.missing.includes(v) ? "✗" : "✓"}
                  </code>
                ))}
              </p>
            )}
            {s.lastCheck && <p className="mt-2 text-xs text-stone-500">Last verified {formatIst(s.lastCheck.checked_at)}: {s.lastCheck.detail}</p>}
            {s.canVerify && verify && (
              <form action={verifyIntegrationAction} className="mt-3">
                <input type="hidden" name="key" value={s.key} />
                <input type="hidden" name="returnTo" value="/integrations" />
                <button className={btn.secondary}>Verify now</button>
              </form>
            )}
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Qualification rules in force" description={`Version ${ruleVersion(rules)}`}>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Hard minimum time to completion</dt>
              <dd>{rules.timeline.hardMinimumWeeks} weeks (services.md)</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Clearly feasible from</dt>
              <dd>{rules.timeline.comfortableMinimumWeeks} weeks (design 3–4 + execution 8+)</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Site must be available within</dt>
              <dd>{rules.timeline.siteReadyMaxWeeks - 2}–{rules.timeline.siteReadyMaxWeeks} weeks (qualified.md)</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Commercial maximum</dt>
              <dd>~{rules.commercial.maxSqft} sq ft (above → review)</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Commercial minimum</dt>
              <dd>
                {rules.commercial.provisionalMinSqft} sq ft{" "}
                <Badge tone={rules.commercial.provisionalMinStatus === "CONFIRMED" ? "green" : "amber"}>{rules.commercial.provisionalMinStatus}</Badge>
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Budget review floors</dt>
              <dd>{Object.keys(rules.budget.floors).length ? "configured (internal)" : "not configured — documented example only"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Service area</dt>
              <dd>Pune city + PCMC</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Call recording</dt>
              <dd>{cfg.recordingEnabled ? "enabled (callers are told)" : "off"}</dd>
            </div>
          </dl>
        </Card>
        <Card title="Recent webhook deliveries" description="From VaaniVoice. Duplicates are ignored safely.">
          {hooks.length === 0 ? (
            <p className="text-sm text-stone-500">No webhooks received yet.</p>
          ) : (
            <Table head={["Received", "Event", "Status"]}>
              {hooks.map((h, i) => (
                <tr key={i}>
                  <Td className="text-xs">{formatIst(h.received_at)}</Td>
                  <Td className="font-mono text-xs">{h.event_type}</Td>
                  <Td>
                    <Badge tone={h.status === "processed" ? "green" : h.status === "failed" ? "red" : "neutral"}>{h.status}</Badge>
                    {h.error && <div className="text-xs text-rose-700">{h.error}</div>}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
