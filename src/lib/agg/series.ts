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

/**
 * The window of `weeks` that a brushed range of chart rows covers, as indices.
 *
 * A brush reports positions in whatever the chart drew, and those are only weeks
 * when the roll-up was weekly — reading a monthly position as a week would zoom
 * to the wrong dates, quietly, with a plausible-looking result. Every row knows
 * the bucket it starts, so the range is resolved through those times instead,
 * which also holds when `rows` cover a slice of `weeks` rather than all of them.
 *
 * Null when the range covers no week at all: an empty chart, or a stale index
 * left over from a chart that has since been redrawn.
 */
export function weekWindow(
  rows: WideRow[],
  weeks: number[],
  startIndex: number,
  endIndex: number,
): { start: number; end: number } | null {
  const from = rows[startIndex]?.week;
  if (from === undefined) return null;
  // The bucket after the last selected one begins where the window ends.
  const after = rows[endIndex + 1]?.week;
  const to = after === undefined ? Infinity : after - 1;

  let start = -1;
  let end = -1;
  for (let i = 0; i < weeks.length; i++) {
    if (weeks[i] < from || weeks[i] > to) continue;
    if (start === -1) start = i;
    end = i;
  }
  return start === -1 ? null : { start, end };
}

/**
 * One pair of y bounds covering several charts, so a set of small multiples can
 * share a scale.
 *
 * Stacking is the reason this is not just a max: a stacked band reaches the sum of
 * its series, while overlaid ones only need to clear the tallest. Signed values
 * make it the reason twice over — negatives stack downwards, so the two directions
 * are measured separately rather than summed against each other.
 *
 * The floor never rises above zero: a chart whose axis starts at its own minimum
 * exaggerates small variation into drama.
 */
export function chartBounds(
  charts: ReadonlyArray<{ keys: readonly string[]; data: readonly WideRow[] }>,
  stacked: boolean,
): { floor: number; ceiling: number } {
  let ceiling = 0;
  let floor = 0;

  for (const chart of charts) {
    for (const row of chart.data) {
      const values = chart.keys.map((k) => row[k] ?? 0);
      const up = values.filter((v) => v > 0);
      const down = values.filter((v) => v < 0);
      const top = stacked ? up.reduce((a, v) => a + v, 0) : Math.max(0, ...up);
      const bottom = stacked ? down.reduce((a, v) => a + v, 0) : Math.min(0, ...down);
      ceiling = Math.max(ceiling, top);
      floor = Math.min(floor, bottom);
    }
  }

  // A flat-zero set of charts still needs a scale to draw against.
  return { floor, ceiling: Math.max(1, ceiling) };
}

/**
 * Each series as its signed share of its row's total churn.
 *
 * The divisor is the sum of magnitudes, not the signed sum: with a metric that can
 * go either way, +300 and -400 in the same week sum to -100, and dividing by that
 * would report shares of 300% and -400%. Against the 700 of movement that actually
 * happened they are +43% and -57%, which is what the band should read.
 *
 * So the shares always fill one unit of axis, and their signs say which direction
 * each series pulled. A row with nothing in it stays at zero rather than dividing
 * by it.
 *
 * Recharts could do this itself with `stackOffset="expand"`, but that divides by
 * the signed sum and comes apart on exactly the mixed rows this exists for.
 */
export function toShares(rows: WideRow[], keys: readonly string[]): WideRow[] {
  return rows.map((row) => {
    const churn = keys.reduce((a, k) => a + Math.abs(row[k] ?? 0), 0);
    const out = { ...row };
    for (const k of keys) out[k] = churn === 0 ? 0 : (row[k] ?? 0) / churn;
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
