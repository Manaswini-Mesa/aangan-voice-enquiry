// Date helpers. All business times are Asia/Kolkata (IST, UTC+05:30, no DST).

export const IST_OFFSET_MINUTES = 330;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Festival dates used when a caller says "before Diwali". Extend yearly. */
export const FESTIVALS: Record<string, string[]> = {
  diwali: ["2026-11-08", "2027-10-29", "2028-10-17"],
  christmas: ["2026-12-25", "2027-12-25", "2028-12-25"],
  "new year": ["2027-01-01", "2028-01-01", "2029-01-01"],
  ganpati: ["2027-09-04", "2028-08-23"],
  holi: ["2027-03-22", "2028-03-11"],
};

export const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));

export function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  const full = MONTHS.indexOf(w);
  if (full >= 0) return full;
  if (w === "sept") return 8;
  return MONTH_ABBR.indexOf(w);
}

/** IST calendar parts for a Date. */
export function istParts(d: Date): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const shifted = new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** UTC Date for a given IST wall-clock time. */
export function istDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month, day, hour, minute) - IST_OFFSET_MINUTES * 60_000);
}

export function weeksBetween(from: Date, to: Date): number {
  return Math.round(((to.getTime() - from.getTime()) / WEEK_MS) * 10) / 10;
}

/**
 * Weeks until the end of the named month (next occurrence). "By March" said in
 * October 2026 means end of March 2027. If the month is the current month, it means
 * this month. An explicit year overrides.
 */
export function weeksUntilEndOfMonth(now: Date, month: number, explicitYear?: number): number {
  const p = istParts(now);
  let year = explicitYear ?? p.year;
  if (explicitYear === undefined && month < p.month) year += 1;
  const end = istDate(year, month + 1, 0, 23, 59); // day 0 of next month = last day of month
  return Math.max(0, weeksBetween(now, end));
}

/** Weeks until the start of the named month (next occurrence). Used for "start in January". */
export function weeksUntilStartOfMonth(now: Date, month: number, explicitYear?: number): number {
  const p = istParts(now);
  let year = explicitYear ?? p.year;
  if (explicitYear === undefined && month <= p.month) year += month === p.month ? 0 : 1;
  const start = istDate(year, month, 1);
  return Math.max(0, weeksBetween(now, start));
}

export function weeksUntilFestival(now: Date, name: string): number | undefined {
  const dates = FESTIVALS[name];
  if (!dates) return undefined;
  for (const iso of dates) {
    const [y, m, d] = iso.split("-").map(Number);
    const date = istDate(y, m - 1, d);
    if (date.getTime() > now.getTime()) return weeksBetween(now, date);
  }
  return undefined;
}

export interface BusinessHours {
  openHour: number; // 10
  closeHour: number; // 19
  /** 0 = Sunday. Front desk covers 10am–7pm; days are configurable. */
  workingDays: number[];
}

export const DEFAULT_BUSINESS_HOURS: BusinessHours = { openHour: 10, closeHour: 19, workingDays: [1, 2, 3, 4, 5, 6] };

export function isWithinBusinessHours(d: Date, hours: BusinessHours = DEFAULT_BUSINESS_HOURS): boolean {
  const p = istParts(d);
  if (!hours.workingDays.includes(p.weekday)) return false;
  return p.hour >= hours.openHour && p.hour < hours.closeHour;
}

/** Next business-hours moment at or after `d` plus `leadMinutes` (used for follow-up due dates). */
export function nextBusinessTime(d: Date, leadMinutes = 60, hours: BusinessHours = DEFAULT_BUSINESS_HOURS): Date {
  let candidate = new Date(d.getTime() + leadMinutes * 60_000);
  for (let i = 0; i < 14; i++) {
    if (isWithinBusinessHours(candidate, hours)) return candidate;
    const p = istParts(candidate);
    const opening = istDate(p.year, p.month, p.day, hours.openHour, 30);
    candidate = opening.getTime() > candidate.getTime() ? opening : istDate(p.year, p.month, p.day + 1, hours.openHour, 30);
  }
  return candidate;
}

export function formatIst(d: Date | string | null | undefined, withTime = true): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: true } : {}),
  }).format(date);
}
