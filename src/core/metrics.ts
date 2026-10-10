// Pure metric calculations over stored records. No figures are hard-coded; empty input → honest zeros.

export interface ResponseRecord {
  first_contact_at: string | Date;
  first_response_at: string | Date | null;
}

export interface ResponseStats {
  total: number;
  responded: number;
  within5Min: number;
  pctWithin5Min: number | null;
  medianSeconds: number | null;
}

export function responseStats(rows: ResponseRecord[], thresholdSeconds = 300): ResponseStats {
  const delays = rows
    .filter((r) => r.first_response_at)
    .map((r) => (new Date(r.first_response_at as string).getTime() - new Date(r.first_contact_at).getTime()) / 1000)
    .filter((s) => Number.isFinite(s) && s >= 0)
    .sort((a, b) => a - b);
  const within = delays.filter((d) => d <= thresholdSeconds).length;
  const median = delays.length ? (delays.length % 2 ? delays[(delays.length - 1) / 2] : (delays[delays.length / 2 - 1] + delays[delays.length / 2]) / 2) : null;
  return {
    total: rows.length,
    responded: delays.length,
    within5Min: within,
    pctWithin5Min: rows.length ? Math.round((within / rows.length) * 1000) / 10 : null,
    medianSeconds: median,
  };
}

export interface UsageRecord {
  provider: string;
  kind: string;
  quantity: number | string;
  unit: string;
  cost_amount: number | string | null;
  cost_currency: string | null;
  cost_type: "actual" | "estimate" | "unavailable";
}

export interface CostSummary {
  /** Actual charges reported by a provider, per currency. Never mixed with estimates. */
  actual: Record<string, number>;
  /** Estimates from configured/list rates, per currency. */
  estimated: Record<string, number>;
  /** Usage with no cost information at all. */
  unavailableCount: number;
  byProvider: Array<{ provider: string; kind: string; unit: string; quantity: number; actual: Record<string, number>; estimated: Record<string, number>; unavailable: number }>;
}

export function costSummary(rows: UsageRecord[]): CostSummary {
  const out: CostSummary = { actual: {}, estimated: {}, unavailableCount: 0, byProvider: [] };
  const groups = new Map<string, CostSummary["byProvider"][number]>();
  for (const r of rows) {
    const key = `${r.provider}|${r.kind}|${r.unit}`;
    const g = groups.get(key) ?? { provider: r.provider, kind: r.kind, unit: r.unit, quantity: 0, actual: {}, estimated: {}, unavailable: 0 };
    g.quantity += Number(r.quantity) || 0;
    const amt = r.cost_amount === null ? null : Number(r.cost_amount);
    if (r.cost_type === "unavailable" || amt === null || !r.cost_currency) {
      g.unavailable += 1;
      out.unavailableCount += 1;
    } else {
      const bucket = r.cost_type === "actual" ? "actual" : "estimated";
      g[bucket][r.cost_currency] = (g[bucket][r.cost_currency] ?? 0) + amt;
      out[bucket][r.cost_currency] = (out[bucket][r.cost_currency] ?? 0) + amt;
    }
    groups.set(key, g);
  }
  out.byProvider = [...groups.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  return out;
}

export function pct(part: number, whole: number): number | null {
  return whole ? Math.round((part / whole) * 1000) / 10 : null;
}
