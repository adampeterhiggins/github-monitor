/**
 * The contribution metrics, and how to read one off a row.
 *
 * Three of them are columns GitHub gives us. `net` is not: it is additions minus
 * deletions, computed here rather than stored, so nothing has to remember to keep
 * a derived column in step. It is also the only one that can be negative, which is
 * the whole reason it is worth having — a week that removed more than it added
 * reads as zero under every other metric.
 */

export type ContributionMetric = "commits" | "additions" | "deletions" | "net";

export const METRICS: Array<{ id: ContributionMetric; label: string }> = [
  { id: "commits", label: "Commits" },
  { id: "additions", label: "Additions" },
  { id: "deletions", label: "Deletions" },
  { id: "net", label: "Net lines" },
];

export function metricLabel(metric: ContributionMetric): string {
  return METRICS.find((m) => m.id === metric)!.label;
}

/** Whether the metric can go below zero, and so needs room under the baseline. */
export function metricCanBeNegative(metric: ContributionMetric): boolean {
  return metric === "net";
}

/**
 * Anything carrying the three stored columns. Written out rather than as an index
 * signature so the row types the queries return are accepted as they are.
 */
export interface MetricRow {
  commits?: number | string | null;
  additions?: number | string | null;
  deletions?: number | string | null;
}

const num = (value: unknown): number => Number(value ?? 0);

/**
 * The metric's value on a row carrying `commits`, `additions` and `deletions`.
 *
 * SQLite hands large integers back as strings often enough that every read goes
 * through `Number`, and a missing column reads as zero rather than NaN — one NaN
 * in a series takes the whole chart with it.
 */
export function metricValue(
  row: MetricRow | null | undefined,
  metric: ContributionMetric,
): number {
  if (!row) return 0;
  if (metric === "net") return num(row.additions) - num(row.deletions);
  return num(row[metric]);
}
