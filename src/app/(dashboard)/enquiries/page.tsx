import Link from "next/link";
import { formatIst } from "@/core/time";
import { Flash } from "@/components/flash";
import { Card, EmptyState, PageHeader, SimBadge, StatusBadge, STATUS_OPTIONS, Table, Td, btn, cx, input } from "@/components/ui";
import { can } from "@/server/auth/permissions";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { filterOptions, listLeads } from "@/server/repo/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Enquiries" };

export default async function EnquiriesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await getDb();
  const { rows, total, page } = await listLeads(db, user, { ...sp, page: Number(sp.page) || 1 });
  const opts = await filterOptions(db);
  const all = can(user.role, "leads:view_all");
  const pageLink = (p: number) => `/enquiries?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(sp).filter(([, v]) => v)) as Record<string, string>), page: String(p) })}`;

  return (
    <>
      <PageHeader title="Enquiries" description={all ? "Every enquiry recorded by the system, newest first." : "Enquiries assigned to you."} />
      <Flash sp={sp} />
      <Card className="mb-4">
        <form className="grid gap-3 md:grid-cols-4 xl:grid-cols-8" action="/enquiries">
          <div className="md:col-span-2">
            <label htmlFor="q" className="mb-1 block text-xs font-medium text-stone-600">
              Search
            </label>
            <input id="q" name="q" defaultValue={sp.q} placeholder="Name, phone, ref, locality, email" className={input} />
          </div>
          <div>
            <label htmlFor="status" className="mb-1 block text-xs font-medium text-stone-600">
              Status
            </label>
            <select id="status" name="status" defaultValue={sp.status ?? ""} className={input}>
              <option value="">All</option>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="type" className="mb-1 block text-xs font-medium text-stone-600">
              Project type
            </label>
            <select id="type" name="type" defaultValue={sp.type ?? ""} className={input}>
              <option value="">All</option>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
            </select>
          </div>
          <div>
            <label htmlFor="locality" className="mb-1 block text-xs font-medium text-stone-600">
              Location
            </label>
            <select id="locality" name="locality" defaultValue={sp.locality ?? ""} className={input}>
              <option value="">All</option>
              {opts.localities.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          {all && (
            <div>
              <label htmlFor="assigned" className="mb-1 block text-xs font-medium text-stone-600">
                Assigned to
              </label>
              <select id="assigned" name="assigned" defaultValue={sp.assigned ?? ""} className={input}>
                <option value="">Anyone</option>
                <option value="none">Unassigned</option>
                {opts.designers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="from" className="mb-1 block text-xs font-medium text-stone-600">
              From
            </label>
            <input id="from" type="date" name="from" defaultValue={sp.from} className={input} />
          </div>
          <div>
            <label htmlFor="to" className="mb-1 block text-xs font-medium text-stone-600">
              To
            </label>
            <input id="to" type="date" name="to" defaultValue={sp.to} className={input} />
          </div>
          <div>
            <label htmlFor="sim" className="mb-1 block text-xs font-medium text-stone-600">
              Data
            </label>
            <select id="sim" name="sim" defaultValue={sp.sim ?? ""} className={input}>
              <option value="">Live + simulated</option>
              <option value="0">Live only</option>
              <option value="only">Simulated only</option>
            </select>
          </div>
          <div className="flex items-end gap-2 md:col-span-2 xl:col-span-1">
            <button className={btn.primary}>Filter</button>
            <Link href="/enquiries" className={btn.secondary}>
              Reset
            </Link>
          </div>
        </form>
      </Card>

      <Card title={`${total} enquir${total === 1 ? "y" : "ies"}`}>
        {rows.length === 0 ? (
          <EmptyState title="No enquiries match">Adjust the filters, or place a test call in the simulator.</EmptyState>
        ) : (
          <Table head={["Ref", "Caller", "Project", "Location", "Received", "Status", "Assigned", "Next action"]}>
            {rows.map((l) => (
              <tr key={l.id} className="hover:bg-stone-50">
                <Td>
                  <Link href={`/enquiries/${l.id}`} className="font-medium text-brand-700 hover:underline">
                    {l.ref}
                  </Link>
                  <div className="mt-1">
                    <SimBadge simulated={l.is_simulated} />
                  </div>
                </Td>
                <Td>
                  <div className="font-medium">{l.caller_name ?? <span className="text-stone-400">Name not given</span>}</div>
                  <div className="text-xs text-stone-500">{l.phone ?? "—"}</div>
                </Td>
                <Td className="max-w-[240px]">
                  <div className="capitalize">{l.project_category ?? (l.enquiry_type !== "new_enquiry" ? l.enquiry_type.replace("_", " ") : "—")}</div>
                  <div className="truncate text-xs text-stone-500" title={l.scope_summary ?? ""}>
                    {l.scope_summary ?? ""}
                  </div>
                </Td>
                <Td>{l.locality ?? "—"}</Td>
                <Td className="whitespace-nowrap">
                  {formatIst(l.created_at)}
                  {l.outside_hours && <div className="text-xs text-stone-500">outside hours</div>}
                </Td>
                <Td>
                  <StatusBadge status={l.status} />
                </Td>
                <Td>{l.designer_name ?? <span className="text-stone-400">—</span>}</Td>
                <Td className="max-w-[220px] text-xs text-stone-600">
                  {l.next_action ?? "—"}
                  {l.next_action_due && <div className={cx(new Date(l.next_action_due) < new Date() ? "text-rose-700" : "text-stone-500")}>due {formatIst(l.next_action_due)}</div>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {total > 50 && (
          <div className="mt-4 flex items-center justify-between text-sm">
            {page > 1 ? <Link className={btn.secondary} href={pageLink(page - 1)}>Previous</Link> : <span />}
            <span className="text-stone-500">
              Page {page} of {Math.ceil(total / 50)}
            </span>
            {page * 50 < total ? <Link className={btn.secondary} href={pageLink(page + 1)}>Next</Link> : <span />}
          </div>
        )}
      </Card>
    </>
  );
}
