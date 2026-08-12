/**
 * Week arithmetic.
 *
 * GitHub's `stats/*` endpoints bucket by week starting **Sunday 00:00 UTC**, and
 * express the bucket as Unix seconds. Every weekly series in this app is keyed on
 * that same integer so series from different endpoints line up without conversion.
 */

export const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** Unix seconds for the Sunday 00:00 UTC that starts the week containing `date`. */
export function weekStart(date: Date | number): number {
  const ms = typeof date === "number" ? date : date.getTime();
  const d = new Date(ms);
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = new Date(utcMidnight).getUTCDay(); // 0 = Sunday
  return Math.floor(utcMidnight / 1000) - dow * 24 * 60 * 60;
}

export function currentWeekStart(now: Date = new Date()): number {
  return weekStart(now);
}

/** The `count` week-starts ending at `endWeek` inclusive, oldest first. */
export function weeksEndingAt(endWeek: number, count: number): number[] {
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(endWeek - i * WEEK_SECONDS);
  return out;
}

/** Inclusive list of week-starts spanning two week-start values. */
export function weekRange(fromWeek: number, toWeek: number): number[] {
  const out: number[] = [];
  for (let w = fromWeek; w <= toWeek; w += WEEK_SECONDS) out.push(w);
  return out;
}

export function weekToDate(week: number): Date {
  return new Date(week * 1000);
}

/**
 * Week buckets to plot on an axis.
 *
 * The range is padded to every week so gaps read as gaps rather than being
 * silently dropped — but "All time" resolves its lower bound to the epoch, which
 * would otherwise generate ~2,900 empty buckets stretching back to 1970. The
 * lower bound is therefore pulled forward to the earliest week that actually has
 * data.
 */
export function axisWeeksFor(
  fromWeek: number,
  toWeek: number,
  dataWeeks: readonly number[],
): number[] {
  if (dataWeeks.length === 0) {
    // Nothing to anchor to; keep at most two years of empty axis.
    const floor = Math.max(fromWeek, toWeek - 104 * WEEK_SECONDS);
    return weekRange(floor, toWeek);
  }
  let earliest = dataWeeks[0];
  for (const w of dataWeeks) if (w < earliest) earliest = w;
  return weekRange(Math.max(fromWeek, earliest), toWeek);
}

export function dayKey(date: Date | number): string {
  const d = typeof date === "number" ? new Date(date) : date;
  return d.toISOString().slice(0, 10);
}

/**
 * A first/last week pair as a period, in ms.
 *
 * The last week runs to its end rather than to its Sunday morning: a range that
 * stopped at the week start would exclude six days of the commits it was built to
 * cover. Null passes through, so callers can hand this an unanswered query.
 */
export function weekSpan(
  bounds: { firstWeek: number; lastWeek: number } | null | undefined,
): { from: number; to: number } | null {
  if (!bounds) return null;
  return {
    from: bounds.firstWeek * 1000,
    to: (bounds.lastWeek + WEEK_SECONDS) * 1000 - 1,
  };
}

/**
 * A `yyyy-mm-dd` from a date input, as UTC ms. Null when it is not a full date,
 * which is what a half-typed field gives.
 *
 * `endOfDay` matters for the upper bound of a range: everything here treats the
 * end as inclusive, and midnight would drop the last day's commits.
 */
export function parseDayInput(value: string, endOfDay = false): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const ms = endOfDay
    ? Date.UTC(+year, +month - 1, +day, 23, 59, 59, 999)
    : Date.UTC(+year, +month - 1, +day);
  return Number.isNaN(ms) ? null : ms;
}

/** GitHub's Insights period options, as offered on the repo-level pages. */
export type PeriodId =
  | "24h"
  | "3d"
  | "1w"
  | "1m"
  | "3m"
  | "6m"
  | "12m"
  | "ytd"
  | "all"
  | "custom";

export interface Period {
  id: PeriodId;
  label: string;
  /** Null for `all`; resolved against "now" at call time. */
  days: number | null;
}

export const PERIODS: Period[] = [
  { id: "24h", label: "Last 24 hours", days: 1 },
  { id: "3d", label: "Last 3 days", days: 3 },
  { id: "1w", label: "Last week", days: 7 },
  { id: "1m", label: "Last month", days: 30 },
  { id: "3m", label: "Last 3 months", days: 90 },
  { id: "6m", label: "Last 6 months", days: 182 },
  { id: "12m", label: "Last 12 months", days: 365 },
  { id: "ytd", label: "Year to date", days: null },
  { id: "all", label: "All time", days: null },
];

export interface ResolvedRange {
  /** Inclusive start, ms. */
  fromMs: number;
  /** Inclusive end, ms. */
  toMs: number;
  fromWeek: number;
  toWeek: number;
}

export function resolvePeriod(
  period: PeriodId,
  opts: { now?: Date; customFrom?: number; customTo?: number; earliestWeek?: number } = {},
): ResolvedRange {
  const now = opts.now ?? new Date();

  /* The custom bounds describe the custom period and nothing else. A remembered
     range is held on to while a preset is selected, and reading its end date as
     the end of "last week" would date the whole page to whenever that range
     happened to finish — with every number still looking perfectly reasonable. */
  const custom = period === "custom" && opts.customFrom != null;
  const toMs = custom ? (opts.customTo ?? now.getTime()) : now.getTime();

  let fromMs: number;
  if (custom) {
    fromMs = opts.customFrom!;
  } else if (period === "all") {
    fromMs = opts.earliestWeek != null ? opts.earliestWeek * 1000 : 0;
  } else if (period === "ytd") {
    fromMs = Date.UTC(now.getUTCFullYear(), 0, 1);
  } else {
    const days = PERIODS.find((p) => p.id === period)?.days ?? 90;
    fromMs = toMs - days * 24 * 60 * 60 * 1000;
  }

  return {
    fromMs,
    toMs,
    fromWeek: weekStart(fromMs),
    toWeek: weekStart(toMs),
  };
}

const MONTH_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const SHORT_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

export function formatDate(d: Date | number): string {
  return MONTH_FMT.format(typeof d === "number" ? new Date(d) : d);
}

export function formatShort(d: Date | number): string {
  return SHORT_FMT.format(typeof d === "number" ? new Date(d) : d);
}

const MONTH_YEAR_FMT = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

/** e.g. "Aug 26" — for axes spanning more than a year. */
export function formatMonthYear(d: Date | number): string {
  return MONTH_YEAR_FMT.format(typeof d === "number" ? new Date(d) : d);
}

/**
 * Pick an axis tick format for a set of week starts.
 *
 * Day-and-month alone is ambiguous once an axis spans years: successive ticks
 * land in the same month of different years and read as "4 Aug, 9 Aug, 8 Aug",
 * which looks like days in one month rather than seven separate years.
 */
export function weekTickFormatter(weeks: readonly number[]): (week: number) => string {
  if (weeks.length < 2) return (w) => formatShort(w * 1000);
  const spanDays = (weeks[weeks.length - 1] - weeks[0]) / 86_400;
  return spanDays > 400
    ? (w) => formatMonthYear(w * 1000)
    : (w) => formatShort(w * 1000);
}
