import Link from "next/link";
import { formatIst } from "@/core/time";
import { RangeFilter } from "@/components/range-filter";
import { Badge, Card, EmptyState, PageHeader, SimBadge, StatusBadge, Table, Td } from "@/components/ui";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { config } from "@/server/env";
import { callsList } from "@/server/repo/queries";
import { parseRange } from "@/server/services/metrics";

export const dynamic = "force-dynamic";
export const metadata = { title: "Call history" };

export default async function CallsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const range = parseRange(sp, config().mode === "demo");
  const rows = await callsList(await getDb(), user, range);
  return (
    <>
      <PageHeader title="Call history" description="Every call session recorded by the system. Live = delivered by the voice provider; Simulated = placed in the simulator or seeded demo data." />
      <RangeFilter path="/calls" current={range.label} sim={range.includeSimulated} from={sp.from} to={sp.to} showSim />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No calls in this period" />
        ) : (
          <Table head={["When", "Source", "Lead", "Outcome", "Call status", "Duration", "Transcript", "Recording"]}>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td className="whitespace-nowrap">
                  {formatIst(c.started_at)}
                  {c.outside_hours && <div className="text-xs text-stone-500">outside hours</div>}
                </Td>
                <Td>
                  <SimBadge simulated={c.mode === "simulated"} />
                  <div className="mt-1 text-xs text-stone-500">{c.provider}</div>
                </Td>
                <Td>
                  <Link className="font-medium text-brand-700 hover:underline" href={`/enquiries/${c.lead_id}`}>
                    {c.ref}
                  </Link>
                  <div className="text-xs text-stone-500">{c.caller_name ?? "Name not given"}</div>
                </Td>
                <Td>
                  <StatusBadge status={c.lead_status} />
                </Td>
                <Td>
                  <Badge tone={c.status === "completed" ? "green" : c.status === "disconnected" ? "amber" : c.status === "failed" ? "red" : "blue"}>{c.status}</Badge>
                  {c.end_reason && <div className="text-xs text-stone-500">{c.end_reason}</div>}
                </Td>
                <Td className="tabular">{c.duration_sec ? `${Math.round(Number(c.duration_sec))}s` : "—"}</Td>
                <Td className="text-xs">{Number(c.segments) > 0 ? `${c.segments} lines` : c.provider_transcript ? "provider copy" : "not available"}</Td>
                <Td className="text-xs">{c.recording_available ? "reference stored" : "none"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
