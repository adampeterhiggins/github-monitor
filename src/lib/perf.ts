/**
 * Development-only timings for the ownership page. They appear as User Timing
 * measures in Web Inspector next to paint, which is what an input-to-paint
 * comparison needs. Production builds skip the bookkeeping.
 */
const enabled = (): boolean => {
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
      && typeof performance !== "undefined" && typeof performance.measure === "function";
  } catch {
    return false;
  }
};

export function measure<T>(name: string, fn: () => T): T {
  if (!enabled()) return fn();
  const start = performance.now();
  const result = fn();
  performance.measure(name, { start, end: performance.now() });
  return result;
}

/** React Profiler callback that records commit durations as measures. */
export function profileRender(id: string, phase: string, actualDuration: number): void {
  if (!enabled()) return;
  const end = performance.now();
  performance.measure(`render:${id}:${phase}`, { start: end - actualDuration, end });
}

export const profiling = enabled;
