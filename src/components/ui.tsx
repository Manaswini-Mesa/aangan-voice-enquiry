import Link from "next/link";
import type { ReactNode } from "react";

// Small, accessible UI primitives shared by dashboard pages (server-component friendly).

export function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(" ");
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-stone-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, description, children, className, actions }: { title?: ReactNode; description?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={cx("rounded-xl border border-stone-200 bg-white shadow-sm", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-stone-100 px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold text-stone-900">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-stone-500">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

const TONES = {
  neutral: "bg-stone-100 text-stone-700 ring-stone-200",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  red: "bg-rose-50 text-rose-800 ring-rose-200",
  amber: "bg-amber-50 text-amber-900 ring-amber-200",
  blue: "bg-sky-50 text-sky-800 ring-sky-200",
  violet: "bg-violet-50 text-violet-800 ring-violet-200",
  brand: "bg-brand-50 text-brand-700 ring-brand-100",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", TONES[tone])}>
      {children}
    </span>
  );
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  new: { label: "New", tone: "blue" },
  in_call: { label: "In call", tone: "blue" },
  incomplete: { label: "Incomplete", tone: "amber" },
  qualified: { label: "Qualified", tone: "green" },
  handed_off: { label: "Handed off", tone: "green" },
  not_qualified: { label: "Not qualified", tone: "neutral" },
  declined: { label: "Declined", tone: "neutral" },
  review: { label: "Needs review", tone: "violet" },
  complaint: { label: "Complaint", tone: "red" },
  existing_client: { label: "Existing client", tone: "blue" },
  closed: { label: "Closed", tone: "neutral" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export const STATUS_OPTIONS = Object.entries(STATUS).map(([value, v]) => ({ value, label: v.label }));

const CRITERION: Record<string, Tone> = { PASS: "green", FAIL: "red", UNKNOWN: "neutral", REVIEW: "violet" };
export function CriterionBadge({ state }: { state: string }) {
  return <Badge tone={CRITERION[state] ?? "neutral"}>{state}</Badge>;
}

export function SimBadge({ simulated }: { simulated: boolean }) {
  return simulated ? (
    <Badge tone="amber" title="Synthetic/simulated record — not a real customer interaction">Simulated</Badge>
  ) : (
    <Badge tone="brand" title="Recorded from a real provider event">Live</Badge>
  );
}

export function Stat({ label, value, hint, href, tone }: { label: string; value: ReactNode; hint?: ReactNode; href?: string; tone?: "warn" | "bad" }) {
  const inner = (
    <div className={cx("h-full rounded-xl border bg-white px-4 py-3.5 shadow-sm transition", href && "hover:border-stone-300 hover:shadow", tone === "bad" ? "border-rose-200" : tone === "warn" ? "border-amber-200" : "border-stone-200")}>
      <div className="text-xs font-medium text-stone-500">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold text-stone-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-stone-500">{hint}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {inner}
    </Link>
  ) : (
    inner
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 px-6 py-10 text-center">
      <p className="text-sm font-medium text-stone-700">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-stone-500">{children}</div>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 py-1.5 text-sm">
      <dt className="text-stone-500">{label}</dt>
      <dd className="col-span-2 text-stone-900">{children ?? <span className="text-stone-400">—</span>}</dd>
    </div>
  );
}

export const btn = {
  primary: "inline-flex items-center justify-center gap-1.5 rounded-lg bg-stone-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50",
  secondary: "inline-flex items-center justify-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3.5 py-2 text-sm font-medium text-stone-800 hover:bg-stone-50 disabled:opacity-50",
  subtle: "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50",
  danger: "inline-flex items-center justify-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3.5 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50",
};

export const input = "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-brand-500 focus:outline-none";

export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500">
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx("px-3 py-2.5 align-top", className)}>{children}</td>;
}

export function Notice({ tone = "amber", children }: { tone?: "amber" | "red" | "blue" | "green"; children: ReactNode }) {
  const t = { amber: "border-amber-200 bg-amber-50 text-amber-900", red: "border-rose-200 bg-rose-50 text-rose-900", blue: "border-sky-200 bg-sky-50 text-sky-900", green: "border-emerald-200 bg-emerald-50 text-emerald-900" }[tone];
  return <div className={cx("rounded-lg border px-4 py-3 text-sm", t)}>{children}</div>;
}
