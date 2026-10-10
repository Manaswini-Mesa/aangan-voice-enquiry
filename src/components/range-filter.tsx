import Link from "next/link";
import { cx } from "./ui";

/** Date-range + simulated-data filter (one row, above the content). Pure links/GET form. */
export function RangeFilter({ path, current, sim, from, to, showSim }: { path: string; current: string; sim: boolean; from?: string; to?: string; showSim: boolean }) {
  const ranges = [
    ["7d", "7 days"],
    ["30d", "30 days"],
    ["90d", "90 days"],
    ["all", "All time"],
  ];
  const q = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ ...(showSim ? { sim: sim ? "1" : "0" } : {}), ...extra });
    return `${path}?${p.toString()}`;
  };
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg border border-stone-300 bg-white p-0.5" role="group" aria-label="Date range">
        {ranges.map(([k, label]) => (
          <Link key={k} href={q({ range: k })} aria-current={current === k ? "true" : undefined} className={cx("rounded-md px-3 py-1.5 text-sm", current === k ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-100")}>
            {label}
          </Link>
        ))}
      </div>
      <form action={path} className="flex flex-wrap items-center gap-2">
        {showSim && <input type="hidden" name="sim" value={sim ? "1" : "0"} />}
        <label className="sr-only" htmlFor="from">
          From
        </label>
        <input id="from" type="date" name="from" defaultValue={from} className="rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-stone-900 focus:border-brand-500 focus:outline-none" />
        <span className="text-sm text-stone-500">to</span>
        <label className="sr-only" htmlFor="to">
          To
        </label>
        <input id="to" type="date" name="to" defaultValue={to} className="rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-stone-900 focus:border-brand-500 focus:outline-none" />
        <button className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm hover:bg-stone-50">Apply</button>
      </form>
      {showSim && (
        <Link href={q({ range: current === "custom" ? "30d" : current, sim: sim ? "0" : "1" })} className="ml-auto text-sm text-brand-700 hover:underline">
          {sim ? "Hide simulated records" : "Include simulated records"}
        </Link>
      )}
    </div>
  );
}
