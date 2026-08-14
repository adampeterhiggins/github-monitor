import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type Database from "@tauri-apps/plugin-sql";
import { useApp } from "./state/app";
import { dayKey, resolvePeriod, type ResolvedRange } from "./agg/weeks";
import type { Logins } from "./db/queries";

/**
 * How completely a page can honour the contributor filter.
 *
 * Several GitHub endpoints carry no contributor dimension at all, so a filter that
 * appeared to apply but silently did nothing would be worse than no filter. Pages
 * declare their support and the filter bar says which case it is.
 */
export type UserFilterSupport =
  /** Every number on the page respects it. */
  | "full"
  /** Some charts respect it; the page names the ones that cannot. */
  | "partial"
  /** GitHub supplies no per-contributor breakdown for this data. */
  | "none";

export interface Scope {
  db: Database | null;
  repoIds: number[];
  /** Null when unfiltered, so queries add no clause at all. */
  logins: Logins;
  /** True when a contributor filter is active. */
  filteredByUser: boolean;
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
 * The slice every page renders against: selected repositories, selected
 * contributors, and the resolved date range. Keeping it in one place is what makes
 * the numbers agree across pages.
 */
export function useScope(): Scope {
  const db = useApp((s) => s.db);
  const repoIds = useApp((s) => s.selectedRepoIds);
  const selectedLogins = useApp((s) => s.selectedLogins);
  const period = useApp((s) => s.period);
  const customFrom = useApp((s) => s.customFrom);
  const customTo = useApp((s) => s.customTo);

  const range = resolvePeriod(period, {
    customFrom: customFrom ?? undefined,
    customTo: customTo ?? undefined,
  });

  // Sorted so selection order never invalidates the cache.
  const sortedRepos = [...repoIds].sort((a, b) => a - b);
  const sortedLogins = [...selectedLogins].sort((a, b) => a.localeCompare(b));
  const logins = sortedLogins.length > 0 ? sortedLogins : null;

  return {
    db,
    repoIds: sortedRepos,
    logins,
    filteredByUser: logins != null,
    range,
    fromIso: new Date(range.fromMs).toISOString(),
    toIso: new Date(range.toMs).toISOString(),
    fromDay: dayKey(range.fromMs),
    toDay: dayKey(range.toMs),
    ready: db != null && sortedRepos.length > 0,
    key: `${period}:${customFrom ?? ""}:${customTo ?? ""}:${sortedRepos.join(",")}:${sortedLogins.join(",")}`,
  };
}

/** react-query wrapper that waits for the scope and keeps the last render during refetch. */
export function useScopedQuery<T>(
  name: string,
  scope: Scope,
  fn: (db: Database) => Promise<T>,
  options: { enabled?: boolean; staleTime?: number; /** Extra cache key when the query is not fully described by the page scope. */ key?: string } = {},
): UseQueryResult<T, Error> {
  return useQuery<T, Error, T, readonly unknown[]>({
    queryKey: [name, scope.key, options.key ?? ""],
    enabled: (options.enabled ?? true) && scope.ready,
    queryFn: () => fn(scope.db!),
    staleTime: options.staleTime ?? 60_000,
    // Charts hold their previous render at reduced opacity rather than flashing.
    placeholderData: keepPreviousData,
  });
}
