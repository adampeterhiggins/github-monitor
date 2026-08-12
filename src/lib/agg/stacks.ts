/**
 * Turn long rows (entity × week × value) into the wide shape a stacked chart wants.
 *
 * The palette has eight categorical slots, assigned in fixed order and never
 * cycled — a ninth colour would either repeat an existing one or be invented, and
 * both make the chart lie about identity. So the top entities by total take the
 * slots and everything else is summed into a single "Other" band, which is honest
 * about being an aggregate rather than pretending to be a category.
 *
 * Colour follows the entity, not its rank: the returned series carry a stable key,
 * so a series keeps its slot when the window changes and only loses it by dropping
 * out of the top N entirely.
 */

export interface StackSeries {
  /** Stable identity, used as the data key. */
  key: string;
  label: string;
  /** Categorical slot 0..7, or null for the folded "Other" band. */
  slot: number | null;
  total: number;
}

export interface StackResult {
  /** One row per week: `{ week, [seriesKey]: value }`. */
  data: Array<Record<string, number>>;
  series: StackSeries[];
  /** How many entities were folded into "Other". */
  foldedCount: number;
}

export const OTHER_KEY = "__other__";

export interface StackInput<T> {
  rows: readonly T[];
  /** Weeks to emit, in order. Weeks with no data still appear, as zeroes. */
  weeks: readonly number[];
  weekOf: (row: T) => number;
  keyOf: (row: T) => string;
  labelOf: (row: T) => string;
  valueOf: (row: T) => number;
  /** Slots available before folding. Defaults to the palette's eight. */
  maxSeries?: number;
}

export function buildStacks<T>({
  rows,
  weeks,
  weekOf,
  keyOf,
  labelOf,
  valueOf,
  maxSeries = 8,
}: StackInput<T>): StackResult {
  const totals = new Map<string, { label: string; total: number }>();
  // key -> week -> value
  const byKey = new Map<string, Map<number, number>>();

  for (const row of rows) {
    const key = keyOf(row);
    const value = valueOf(row);
    if (value === 0) continue;

    const seen = totals.get(key);
    if (seen) seen.total += value;
    else totals.set(key, { label: labelOf(row), total: value });

    let weekMap = byKey.get(key);
    if (!weekMap) {
      weekMap = new Map();
      byKey.set(key, weekMap);
    }
    weekMap.set(weekOf(row), (weekMap.get(weekOf(row)) ?? 0) + value);
  }

  const ranked = [...totals.entries()]
    .map(([key, v]) => ({ key, label: v.label, total: v.total }))
    // Ties broken by key so the ordering is stable rather than dependent on
    // insertion order, which would make colours flicker between renders.
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));

  const top = ranked.slice(0, maxSeries);
  const folded = ranked.slice(maxSeries);

  const series: StackSeries[] = top.map((entry, index) => ({
    key: entry.key,
    label: entry.label,
    slot: index,
    total: entry.total,
  }));

  if (folded.length > 0) {
    series.push({
      key: OTHER_KEY,
      label: `Other (${folded.length})`,
      slot: null,
      total: folded.reduce((a, f) => a + f.total, 0),
    });
  }

  const data = weeks.map((week) => {
    const row: Record<string, number> = { week };
    for (const s of top) row[s.key] = byKey.get(s.key)?.get(week) ?? 0;
    if (folded.length > 0) {
      let other = 0;
      for (const f of folded) other += byKey.get(f.key)?.get(week) ?? 0;
      row[OTHER_KEY] = other;
    }
    return row;
  });

  return { data, series, foldedCount: folded.length };
}
