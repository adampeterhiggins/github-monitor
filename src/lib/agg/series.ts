import { WEEK_SECONDS } from "./weeks";

/**
 * Reshaping a weekly series for the timeline views: rolling weeks up into larger
 * buckets, and turning per-period counts into a running total.
 *
 * Both are pure functions over the wide `{ week, [seriesKey]: value }` rows the
 * charts consume, and both are easy to get subtly wrong in ways that still draw a
 * plausible curve — a cumulative series that resets, or a roll-up that drops the
 * final partial month — so they live here rather than inline in a component.
 */

export type Granularity = "week" | "month" | "quarter";

export const GRANULARITIES: Array<{ id: Granularity; label: string }> = [
  { id: "week", label: "Weekly" },
  { id: "month", label: "Monthly" },
  { id: "quarter", label: "Quarterly" },
];

export type WideRow = Record<string, number>;

/** Bucket start (Unix seconds, UTC) that a week belongs to. */
export function bucketStart(week: number, granularity: Granularity): number {
  if (granularity === "week") return week;
  const d = new Date(week * 1000);
  const month = d.getUTCMonth();
  const startMonth = granularity === "quarter" ? Math.floor(month / 3) * 3 : month;
  return Math.floor(Date.UTC(d.getUTCFullYear(), startMonth, 1) / 1000);
}

/**
 * Roll weekly rows up into larger buckets.
 *
 * A week is assigned to the bucket its *start* falls in, so a week spanning a
 * month boundary counts once rather than being split — GitHub's weekly totals
 * cannot be apportioned across days anyway, and double counting would be worse
 * than a slight edge effect.
 */
export function rollUp(rows: WideRow[], seriesKeys: string[], granularity: Granularity): WideRow[] {
  if (granularity === "week" || rows.length === 0) return rows;

  const buckets = new Map<number, WideRow>();
  for (const row of rows) {
    const key = bucketStart(row.week, granularity);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { week: key };
      for (const k of seriesKeys) bucket[k] = 0;
      buckets.set(key, bucket);
    }
    for (const k of seriesKeys) bucket[k] = (bucket[k] ?? 0) + (row[k] ?? 0);
  }

  return [...buckets.values()].sort((a, b) => a.week - b.week);
}

/**
 * Turn per-period values into a running total.
 *
 * Carries the previous value forward across buckets with no activity, so the line
 * plateaus rather than dropping to zero — a cumulative series that falls is simply
 * wrong, and it is the easiest mistake to make here.
 */
export function toCumulative(rows: WideRow[], seriesKeys: string[]): WideRow[] {
  const running: Record<string, number> = {};
  for (const k of seriesKeys) running[k] = 0;

  return rows.map((row) => {
    const out: WideRow = { week: row.week };
    for (const k of seriesKeys) {
      running[k] += row[k] ?? 0;
      out[k] = running[k];
    }
    return out;
  });
}

/** Label for a bucket, given the granularity it was built at. */
export function bucketLabel(week: number, granularity: Granularity): string {
  const d = new Date(week * 1000);
  if (granularity === "quarter") {
    return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
  }
  if (granularity === "month") {
    return new Intl.DateTimeFormat("en-GB", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(d);
  }
  return `Week of ${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d)}`;
}

/** How many weeks a bucket nominally spans, for describing the axis. */
export function bucketWeeks(granularity: Granularity): number {
  if (granularity === "quarter") return 13;
  if (granularity === "month") return 4;
  return 1;
}

export { WEEK_SECONDS };
