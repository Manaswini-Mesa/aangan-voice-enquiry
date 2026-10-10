import Link from "next/link";
import { formatIst } from "@/core/time";
import { complaintAction } from "../../actions";
import { Flash } from "@/components/flash";
import { Badge, Card, EmptyState, PageHeader, SimBadge, btn, input } from "@/components/ui";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { complaintsList } from "@/server/repo/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Complaints" };

export default async function ComplaintsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await requireUser("complaints:manage");
  const rows = await complaintsList(await getDb());
  return (
    <>
      <PageHeader title="Existing-client complaints" description="Escalations from current clients. Kept separate from new enquiries and never treated as leads." />
      <Flash sp={sp} />
      {rows.length === 0 ? (
        <EmptyState title="No complaints recorded" />
      ) : (
        <div className="space-y-3">
          {rows.map((c) => (
            <Card key={c.id}>
              <div className="flex flex-col gap-3 lg:flex-row lg:justify-between">
                <div className="max-w-2xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link className="font-semibold text-brand-700 hover:underline" href={`/enquiries/${c.lead_id}`}>
                      {c.ref}
                    </Link>
                    <Badge tone={c.status === "resolved" ? "green" : c.status === "acknowledged" ? "amber" : "red"}>{c.status}</Badge>
                    <SimBadge simulated={c.is_simulated} />
                    <span className="text-xs text-stone-500">Raised {formatIst(c.created_at)}</span>
                  </div>
                  <p className="mt-1 text-sm">
                    <b>{c.client_name ?? "Name not given"}</b>
                    {c.phone && <span className="text-stone-500"> · {c.phone}</span>}
                    {c.designer_name && <span className="text-stone-500"> · designer: {c.designer_name}</span>}
                    {c.project_ref && <span className="text-stone-500"> · {c.project_ref}</span>}
                  </p>
                  <p className="mt-2 text-sm text-stone-700">“{c.summary}”</p>
                  {c.resolution && <p className="mt-1 text-xs text-stone-500">Note: {c.resolution}</p>}
                </div>
                {c.status !== "resolved" && (
                  <form action={complaintAction} className="flex w-full max-w-sm flex-col gap-2">
                    <input type="hidden" name="complaintId" value={c.id} />
                    <input type="hidden" name="returnTo" value="/complaints" />
                    <input name="note" placeholder="Note (who called back, outcome)" aria-label="Note" className={input} />
                    <div className="flex gap-2">
                      {c.status === "open" && (
                        <button name="status" value="acknowledged" className={btn.secondary}>
                          Acknowledged
                        </button>
                      )}
                      <button name="status" value="resolved" className={btn.primary}>
                        Resolved
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
