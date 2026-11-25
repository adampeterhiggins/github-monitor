import { useMemo } from "react";
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type Database from "@tauri-apps/plugin-sql";
import { useApp } from "./state/app";
import { dayKey, resolvePeriod, type ResolvedRange } from "./agg/weeks";
import type { Logins, RepoRow } from "./db/queries";

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
  /** True when the period only filters chart x-axes without narrowing calculations. */
  xAxisOnly: boolean;
  range: ResolvedRange;
  /**
   * The date range used for data queries when calculations stay across all
   * history (`xAxisOnly`), or `range` otherwise.
   */
  dataRange: ResolvedRange;
  fromIso: string;
  toIso: string;
  fromDay: string;
  toDay: string;
  dataFromDay: string;
  dataToDay: string;
  /** False when there is nothing to query — no db, or no repositories selected. */
  ready: boolean;
  /** Stable cache key for the current slice. */
  key: string;
  /** Stable cache key for `dataRange` queries — unchanged when only the x-axis window moves. */
  dataKey: string;
}

/**
 * Repositories in organisations the organisation filter leaves switched on. The
 * filter only exists with several organisations, so with one it never hides
 * anything — otherwise removing the others could strand a hidden last one.
 */
export function useOrgVisibleRepos(): RepoRow[] {
  const repos = useApp((s) => s.repos);
  const orgCount = useApp((s) => s.orgs.length);
  const hiddenOrgs = useApp((s) => s.hiddenOrgs);
  return useMemo(() => {
    if (orgCount < 2 || hiddenOrgs.length === 0) return repos;
    const hidden = new Set(hiddenOrgs);
    return repos.filter((r) => !hidden.has(r.owner.toLowerCase()));
  }, [repos, orgCount, hiddenOrgs]);
}

/** Selected repositories, less those in organisations filtered out. */
export function useScopedRepoIds(): number[] {
  const selected = useApp((s) => s.selectedRepoIds);
  const visible = useOrgVisibleRepos();
  const allRepos = useApp((s) => s.repos);
  return useMemo(() => {
    if (visible === allRepos) return selected;
    const ids = new Set(visible.map((r) => r.id));
    return selected.filter((id) => ids.has(id));
  }, [selected, visible, allRepos]);
}

/**
 * The slice every page renders against: selected repositories, selected
 * contributors, and the resolved date range. Keeping it in one place is what makes
 * the numbers agree across pages.
 */
export function useScope(): Scope {
  const db = useApp((s) => s.db);
  const repoIds = useScopedRepoIds();
  const selectedLogins = useApp((s) => s.selectedLogins);
  const period = useApp((s) => s.period);
  const customFrom = useApp((s) => s.customFrom);
  const customTo = useApp((s) => s.customTo);
  const xAxisOnly = useApp((s) => s.periodXAxisOnly);

  const range = resolvePeriod(period, {
    customFrom: customFrom ?? undefined,
    customTo: customTo ?? undefined,
  });
  const dataRange = xAxisOnly ? resolvePeriod("all") : range;

  // Sorted so selection order never invalidates the cache.
  const sortedRepos = [...repoIds].sort((a, b) => a - b);
  const sortedLogins = [...selectedLogins].sort((a, b) => a.localeCompare(b));
  const logins = sortedLogins.length > 0 ? sortedLogins : null;
  const entityKey = `${sortedRepos.join(",")}:${sortedLogins.join(",")}`;
  const periodKey = `${period}:${customFrom ?? ""}:${customTo ?? ""}:${xAxisOnly ? "axis" : "data"}`;

  return {
    db,
    repoIds: sortedRepos,
    logins,
    filteredByUser: logins != null,
    xAxisOnly,
    range,
    dataRange,
    fromIso: new Date(range.fromMs).toISOString(),
    toIso: new Date(range.toMs).toISOString(),
    fromDay: dayKey(range.fromMs),
    toDay: dayKey(range.toMs),
    dataFromDay: dayKey(dataRange.fromMs),
    dataToDay: dayKey(dataRange.toMs),
    ready: db != null && sortedRepos.length > 0,
    key: `${periodKey}:${entityKey}`,
    dataKey: xAxisOnly ? `all:::${entityKey}` : `${period}:${customFrom ?? ""}:${customTo ?? ""}:${entityKey}`,
  };
}

/** react-query wrapper that waits for the scope and keeps the last render during refetch. */
export function useScopedQuery<T>(
  name: string,
  scope: Scope,
  fn: (db: Database) => Promise<T>,
  options: {
    enabled?: boolean;
    staleTime?: number;
    /** Extra cache key when the query is not fully described by the page scope. */
    key?: string;
    /** Key the query by `scope.dataKey` so x-axis-only period changes reuse cached all-time results. */
    useDataRange?: boolean;
  } = {},
): UseQueryResult<T, Error> {
  return useQuery<T, Error, T, readonly unknown[]>({
    queryKey: [name, options.useDataRange ? scope.dataKey : scope.key, options.key ?? ""],
    enabled: (options.enabled ?? true) && scope.ready,
    queryFn: () => fn(scope.db!),
    staleTime: options.staleTime ?? 60_000,
    // Charts hold their previous render at reduced opacity rather than flashing.
    placeholderData: keepPreviousData,
  });
}
