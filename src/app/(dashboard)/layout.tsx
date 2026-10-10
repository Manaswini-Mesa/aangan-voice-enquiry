import Link from "next/link";
import { logoutAction } from "../actions";
import { Nav, type NavItem } from "@/components/nav";
import { can } from "@/server/auth/permissions";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { config } from "@/server/env";

export const dynamic = "force-dynamic";

async function counts() {
  try {
    const db = await getDb();
    const r = await db.query<{ review: string; complaints: string; work: string }>(
      `SELECT (SELECT count(*) FROM leads WHERE status = 'review')::text AS review,
              (SELECT count(*) FROM complaints WHERE status <> 'resolved')::text AS complaints,
              (SELECT count(*) FROM follow_ups WHERE status = 'open' AND due_at < now())::text AS work`,
    );
    return { review: Number(r[0].review), complaints: Number(r[0].complaints), work: Number(r[0].work) };
  } catch {
    return { review: 0, complaints: 0, work: 0 };
  }
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const cfg = config();
  const c = can(user.role, "leads:view_all") ? await counts() : { review: 0, complaints: 0, work: 0 };
  const items: NavItem[] = [
    { href: "/", label: "Overview" },
    { href: "/enquiries", label: "Enquiries" },
    ...(can(user.role, "review:decide") ? [{ href: "/review", label: "Review queue", count: c.review }] : []),
    { href: "/workspace", label: "Handoffs & follow-ups", count: c.work },
    ...(can(user.role, "complaints:manage") ? [{ href: "/complaints", label: "Complaints", count: c.complaints }] : []),
    { href: "/calls", label: "Call history" },
    ...(can(user.role, "simulator:use") ? [{ href: "/simulator", label: "Call simulator" }] : []),
    ...(can(user.role, "costs:view") ? [{ href: "/costs", label: "Costs & performance" }] : []),
    ...(can(user.role, "integrations:view") ? [{ href: "/integrations", label: "Integrations" }] : []),
  ];
  return (
    <div className="min-h-screen">
      {cfg.isVercel && !cfg.databaseUrl && (
        <div role="alert" className="bg-rose-100 px-4 py-2 text-center text-xs font-medium text-rose-900">
          No DATABASE_URL on Vercel: each serverless function keeps its own temporary demo database, so records created in one place (e.g. the
          simulator) may not appear in another, and data resets when instances restart. Add a Neon DATABASE_URL for a consistent demo or for live use.
        </div>
      )}
      {cfg.mode === "demo" ? (
        <div role="note" className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900">
          DEMO MODE — all enquiries are synthetic and simulated. No phone calls are answered and no emails are sent.
        </div>
      ) : (
        <div role="note" className="bg-stone-900 px-4 py-1.5 text-center text-xs font-medium text-stone-100">
          LIVE MODE — real customer data. Simulated test calls are labelled “Simulated”.
        </div>
      )}
      <header className="relative flex h-14 items-center justify-between border-b border-stone-200 bg-white px-4 lg:hidden">
        <Link href="/" className="font-semibold">
          Aangan Enquiries
        </Link>
        <div className="flex items-center gap-2">
          <form action={logoutAction}>
            <button type="submit" className="text-xs font-medium text-brand-700">
              Sign out
            </button>
          </form>
          <Nav items={items} />
        </div>
      </header>
      <div className="mx-auto flex max-w-[1400px]">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-stone-200 bg-white px-3 py-5 lg:flex">
          <Link href="/" className="mb-6 flex items-center gap-2 px-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 font-semibold text-white">A</span>
            <span>
              <span className="block text-sm font-semibold leading-tight">Aangan Studio</span>
              <span className="block text-xs text-stone-500">Enquiries</span>
            </span>
          </Link>
          <Nav items={items} />
          <div className="mt-auto border-t border-stone-100 px-2 pt-4">
            <p className="truncate text-sm font-medium text-stone-800">{user.name}</p>
            <p className="text-xs capitalize text-stone-500">{user.role}</p>
            <form action={logoutAction}>
              <button type="submit" className="mt-2 text-xs font-medium text-brand-700 hover:underline">
                Sign out
              </button>
            </form>
          </div>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
