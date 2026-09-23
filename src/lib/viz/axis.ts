/** Y-axis ranges for charts that can stretch to their data. */

/** A round tick step that splits `span` into about four intervals. */
function niceStep(span: number): number {
  const raw = span / 4;
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const n = raw / magnitude;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * magnitude;
}

/**
 * The y range the visible series actually use, rounded out to tidy ticks. A stack
 * or a share keeps zero as its floor unless something goes below it.
 */
export function fitAxis(
  rows: ReadonlyArray<Record<string, number>>,
  keys: readonly string[],
  stacked: boolean,
  share: boolean,
): { domain: [number, number]; ticks: number[] } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of rows) {
    if (stacked) {
      let up = 0;
      let down = 0;
      for (const k of keys) {
        const v = Number(row[k] ?? 0);
        if (v > 0) up += v;
        else down += v;
      }
      hi = Math.max(hi, up);
      lo = Math.min(lo, down);
    } else {
      for (const k of keys) {
        const v = Number(row[k] ?? 0);
        hi = Math.max(hi, v);
        lo = Math.min(lo, v);
      }
    }
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null;
  const floor = stacked || share ? Math.min(0, lo) : lo;
  const step = niceStep(hi - floor);
  let top = Math.ceil(hi / step) * step;
  // Headroom when the peak lands on a tick, but a share never passes 100%.
  if (top === hi && hi > 0) top += step;
  if (share && hi <= 1) top = Math.min(top, 1);
  const bottom = Math.floor(floor / step) * step;
  const ticks: number[] = [];
  for (let t = bottom; t <= top + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  return { domain: [bottom, top], ticks };
}
