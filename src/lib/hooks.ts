import { keepPreviousData, useIsFetching, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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

  return useMemo(() => {
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
  }, [db, repoIds, selectedLogins, period, customFrom, customTo]);
}

/**
 * The same slice, but it lags one render behind the filters.
 *
 * Filter controls write the live store immediately so a checkbox can paint. Pages
 * that rebuild charts from the slice should read this instead, or every tick in
 * the repository menu waits on those charts.
 */
export function useDeferredScope(): Scope {
  return useDeferredValue(useScope());
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
    /**
     * Replace `scope.key` in the cache key. Use when the query does not actually
     * depend on the selected repositories — otherwise ticking one repo refetches
     * a result that cannot have changed.
     */
    cacheKey?: string;
    /**
     * Run even when no repositories are selected. The repo filter needs totals
     * across every repository in order to pick some.
     */
    allowEmptySelection?: boolean;
  } = {},
): UseQueryResult<T, Error> {
  return useQuery<T, Error, T, readonly unknown[]>({
    queryKey: [name, options.cacheKey ?? scope.key, options.key ?? ""],
    enabled: (options.enabled ?? true) && (options.allowEmptySelection ? scope.db != null : scope.ready),
    queryFn: () => fn(scope.db!),
    staleTime: options.staleTime ?? 60_000,
    // Charts hold their previous render at reduced opacity rather than flashing.
    placeholderData: keepPreviousData,
  });
}

/**
 * Queries that belong to the filter chrome, not the page. Counting them as
 * "the view is loading" would flash the whole page whenever someone opens the
 * repository menu.
 */
const FILTER_CHROME_QUERIES = new Set([
  "repo-filter-totals",
  "contributor-list",
  "contributor-list-bots",
  "commit-week-bounds",
  "commit-week-bounds-me",
  "saved-filters",
  "repo-activity",
  "repo-activity-mine",
  "author-probe",
  "repo-stats",
  "repo-endpoint-status",
  "outstanding-work",
  "sync-problems",
]);

export interface PageBusy {
  /** The live filters have moved on; the charts have not yet. */
  catchingUp: boolean;
  /** A page query is in flight (previous data is still on screen). */
  fetching: boolean;
  /** Show the loading chrome — catching up, or fetching that lasted long enough. */
  busy: boolean;
  label: string;
}

/**
 * Whether the current view is still catching up after a filter or chart change.
 *
 * Filters update immediately so a checkbox can paint. Charts and queries lag
 * on purpose; this is how the rest of the UI says so, instead of looking frozen.
 *
 * `extraPending` is for page-local deferred work (chart options) that is not
 * part of the shared filter slice.
 */
export function usePageBusy(extraPending = false): PageBusy {
  const live = useScope();
  const deferred = useDeferredScope();
  const catchingUp = extraPending || (live.ready && live.key !== deferred.key);
  const fetchingCount = useIsFetching({
    predicate: (query) => {
      const name = query.queryKey[0];
      return typeof name !== "string" || !FILTER_CHROME_QUERIES.has(name);
    },
  });
  const fetching = fetchingCount > 0;

  const [shown, setShown] = useState(false);
  const shownRef = useRef(false);
  shownRef.current = shown;

  useEffect(() => {
    const active = catchingUp || fetching;
    if (active) {
      // Catching up is already a missed paint — show at once. A cached refetch
      // that finishes in a frame should not flash the banner. Once the chrome is
      // up, stay up across catching-up → fetch so the two phases do not flicker.
      const wait = catchingUp || shownRef.current ? 0 : 120;
      const show = setTimeout(() => setShown(true), wait);
      return () => clearTimeout(show);
    }
    const hide = setTimeout(() => setShown(false), 180);
    return () => clearTimeout(hide);
  }, [catchingUp, fetching]);

  const [label, setLabel] = useState("Loading…");
  useEffect(() => {
    if (catchingUp) setLabel("Updating this view…");
    else if (fetching) setLabel("Loading…");
  }, [catchingUp, fetching]);

  return useMemo(
    () => ({ catchingUp, fetching, busy: catchingUp || shown, label }),
    [catchingUp, fetching, shown, label],
  );
}
