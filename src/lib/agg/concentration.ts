/**
 * How concentrated a set of counts is — the bus-factor question.
 *
 * Given one number per person (commits in a repository, say), these answer
 * "what share sits with the top K" without the page having to re-derive the
 * arithmetic. The failure modes are the usual ones: dividing by a zero total,
 * or a rounding scheme for a 100-cell waffle that does not add up to 100.
 */

export interface Concentration {
  total: number;
  /** People with a positive count. */
  contributors: number;
  /** Share of the total held by the single largest count, 0..1. */
  top1: number;
  top3: number;
  top5: number;
}

/** Top-K shares of a bag of counts. Empty or all-zero input is all zeroes. */
export function concentration(counts: readonly number[]): Concentration {
  const sorted = counts.filter((n) => n > 0).sort((a, b) => b - a);
  const total = sorted.reduce((a, n) => a + n, 0);
  const share = (k: number) => {
    if (total === 0) return 0;
    let sum = 0;
    for (let i = 0; i < k && i < sorted.length; i++) sum += sorted[i];
    return sum / total;
  };
  return {
    total,
    contributors: sorted.length,
    top1: share(1),
    top3: share(3),
    top5: share(5),
  };
}

/**
 * Largest-remainder allocation of `units` across `weights`.
 *
 * Used to paint a 100-cell waffle so the cells are a fair reading of the
 * shares and still sum to exactly 100. Zero weights stay zero; a zero total
 * yields all zeroes rather than inventing a uniform split.
 */
export function allocateUnits(weights: readonly number[], units: number): number[] {
  if (units <= 0) return weights.map(() => 0);
  const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (total <= 0) return weights.map(() => 0);

  const raw = weights.map((w) => (Math.max(0, w) / total) * units);
  const floors = raw.map((v) => Math.floor(v));
  let remain = units - floors.reduce((a, n) => a + n, 0);

  // Ties broken by index so the leftover cells do not flicker between renders.
  const order = raw
    .map((v, i) => ({ i, frac: v - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = [...floors];
  for (let k = 0; k < remain; k++) out[order[k].i] += 1;
  return out;
}
