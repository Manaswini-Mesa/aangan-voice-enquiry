import Link from "next/link";
import { formatIst } from "@/core/time";
import { Flash } from "@/components/flash";
import { Badge, Card, EmptyState, PageHeader, SimBadge } from "@/components/ui";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { reviewQueue } from "@/server/repo/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review queue" };

const GROUP: Array<[string, string]> = [
  ["TIMELINE", "Borderline timeline"],
  ["COMMERCIAL_SIZE", "Provisional commercial size (pending Nikhil’s confirmation)"],
  ["BUDGET", "Budget concern"],
  ["AUTHORITY", "Authority not established"],
  ["LOCATION", "Location needs checking"],
  ["SCOPE", "Uncertain scope"],
  ["CONFLICT", "Conflicting answers"],
];

function groupOf(code: string): string {
  return GROUP.find(([k]) => code.startsWith(k))?.[1] ?? "Other";
}

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await requireUser("review:decide");
  const rows = await reviewQueue(await getDb());
  return (
    <>
      <PageHeader title="Human review" description="Cases the rules engine could not decide safely. Open a case to record a decision and rationale; the automated assessment is preserved." />
      <Flash sp={sp} />
      {rows.length === 0 ? (
        <EmptyState title="Nothing waiting for review" />
      ) : (
        <div className="space-y-3">
          {rows.map((l) => (
            <Card key={l.id}>
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/enquiries/${l.id}`} className="font-semibold text-brand-700 hover:underline">
                      {l.ref}
                    </Link>
                    <span className="text-sm">{l.caller_name ?? "Name not given"}</span>
                    <SimBadge simulated={l.is_simulated} />
                    <span className="text-xs text-stone-500">{formatIst(l.created_at)}</span>
                  </div>
                  <p className="mt-1 text-sm text-stone-600">
                    {[l.scope_summary, l.locality, l.timeline_summary].filter(Boolean).join(" · ") || "Few details captured"}
                  </p>
                  <ul className="mt-2 space-y-1">
                    {l.review_reasons.map((r, i) => (
                      <li key={i} className="text-sm">
                        <Badge tone="violet">{groupOf(r.code)}</Badge> <span className="text-stone-700">{r.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <Link href={`/enquiries/${l.id}`} className="shrink-0 rounded-lg bg-stone-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-stone-800">
                  Review case
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
