import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type Database from "@tauri-apps/plugin-sql";
import { useApp } from "./state/app";
import { dayKey, resolvePeriod, type ResolvedRange } from "./agg/weeks";

export interface Scope {
  db: Database | null;
  repoIds: number[];
  range: ResolvedRange;
  fromIso: string;
  toIso: string;
  fromDay: string;
  toDay: string;
  /** False when there is nothing to query — no db, or no repositories selected. */
  ready: boolean;
  /** Stable cache key for the current slice. */
  key: string;
}

/**
 * The slice every page renders against: selected repositories plus the resolved
 * date range. Keeping it in one place is what makes the numbers agree across pages.
 */
export function useScope(): Scope {
  const db = useApp((s) => s.db);
  const repoIds = useApp((s) => s.selectedRepoIds);
  const period = useApp((s) => s.period);
  const customFrom = useApp((s) => s.customFrom);
  const customTo = useApp((s) => s.customTo);

  const range = resolvePeriod(period, {
    customFrom: customFrom ?? undefined,
    customTo: customTo ?? undefined,
  });

  // Repo ids are sorted so selection order never invalidates the cache.
  const sorted = [...repoIds].sort((a, b) => a - b);

  return {
    db,
    repoIds: sorted,
    range,
    fromIso: new Date(range.fromMs).toISOString(),
    toIso: new Date(range.toMs).toISOString(),
    fromDay: dayKey(range.fromMs),
    toDay: dayKey(range.toMs),
    ready: db != null && sorted.length > 0,
    key: `${period}:${customFrom ?? ""}:${customTo ?? ""}:${sorted.join(",")}`,
  };
}

/** react-query wrapper that waits for the scope and keeps the last render during refetch. */
export function useScopedQuery<T>(
  name: string,
  scope: Scope,
  fn: (db: Database) => Promise<T>,
  options: { enabled?: boolean; staleTime?: number } = {},
): UseQueryResult<T, Error> {
  return useQuery<T, Error, T, readonly unknown[]>({
    queryKey: [name, scope.key],
    enabled: (options.enabled ?? true) && scope.ready,
    queryFn: () => fn(scope.db!),
    staleTime: options.staleTime ?? 60_000,
    // Charts hold their previous render at reduced opacity rather than flashing.
    placeholderData: keepPreviousData,
  });
}
