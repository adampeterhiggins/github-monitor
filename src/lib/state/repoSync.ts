import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApp } from "./app";
import { repoEndpointStatus } from "../db/queries";
import type { SyncStatus } from "../db";
import {
  ALL_ENDPOINTS,
  ENDPOINT_LABELS,
  runSync,
  shouldSkip,
  type EndpointId,
  type SyncMode,
} from "../ingest/sync";

/**
 * Per-repository sync status and the ability to sync one repository on its own.
 *
 * The whole-org sync is all-or-nothing, which is awkward when a single repository
 * is the one that failed or is still being computed by GitHub — re-running
 * everything to fix one repository is a lot of wasted requests. `runSync` already
 * accepts a repo id list and per-endpoint checkpoints, so a single-repository run
 * is the same code path with a narrower target.
 */

export type RepoSyncState = "never" | "complete" | "outstanding";

export interface RepoSyncSummary {
  state: RepoSyncState;
  /** Endpoints finished for this repository. */
  complete: number;
  /** Endpoints still to do: pending, errored or never attempted. */
  outstanding: number;
  /** Of the outstanding, interrupted work or statistics still computing. */
  pending: number;
  /** Of the outstanding, those that failed. */
  errored: number;
  /** Human-readable list of what is outstanding, for a tooltip. */
  detail: string;
}

export interface RepoSyncController {
  /** repo id -> summary against the currently selected endpoints. */
  summaries: Map<number, RepoSyncSummary>;
  /** The repository currently being synced on its own, if any. */
  activeRepoId: number | null;
  /** True while any sync is running, including the whole-org one. */
  busy: boolean;
  syncRepo: (repoId: number, mode: SyncMode) => Promise<void>;
  /**
   * Retry one (repository, endpoint) pair — the narrowest unit of work there is.
   * Used by the Incomplete data list, where the whole point is that only that one
   * thing failed.
   */
  retryPair: (repoId: number, endpoint: EndpointId) => Promise<void>;
  /** The pair currently being retried, as `repoId:endpoint`. */
  activePair: string | null;
  refresh: () => void;
}

/**
 * @param repoIds repositories to report on — every row the table shows, not just
 *   the selected ones, so an unselected repository can still be synced on its own
 *   rather than showing a blank cell.
 */
export function useRepoSync(
  repoIds: number[],
  endpoints: EndpointId[] = ALL_ENDPOINTS,
): RepoSyncController {
  const { db, token, orgs, syncing, setSyncing, setSync, reloadSyncTime } = useApp();
  const queryClient = useQueryClient();
  const [activeRepoId, setActiveRepoId] = useState<number | null>(null);
  const [activePair, setActivePair] = useState<string | null>(null);

  const idsKey = repoIds.join(",");
  const statuses = useQuery({
    queryKey: ["repo-endpoint-status", idsKey, syncing],
    enabled: db != null && repoIds.length > 0,
    queryFn: () => repoEndpointStatus(db!, repoIds),
    staleTime: 5_000,
  });

  const summaries = useMemo(() => {
    const byRepo = new Map<number, Map<string, { status: string; error: string | null }>>();
    for (const row of statuses.data ?? []) {
      let m = byRepo.get(row.repo_id);
      if (!m) {
        m = new Map();
        byRepo.set(row.repo_id, m);
      }
      m.set(row.endpoint, { status: row.status, error: row.error });
    }

    const out = new Map<number, RepoSyncSummary>();
    for (const repoId of repoIds) {
      const recorded = byRepo.get(repoId) ?? new Map<string, { status: string; error: string | null }>();
      let complete = 0;
      let pending = 0;
      let errored = 0;
      const outstandingLabels: string[] = [];

      for (const endpoint of endpoints) {
        const row = recorded.get(endpoint);
        // Widened from the database, where the column is plain text. shouldSkip is
        // a set-membership test, so an unrecognised value is simply not terminal.
        const status = row?.status as SyncStatus | undefined;
        // Reuse the sync's own definition of "finished" so this badge and the
        // resume behaviour can never disagree about what "done" means.
        if (shouldSkip(status, "resume")) {
          complete++;
          continue;
        }
        const label = ENDPOINT_LABELS[endpoint] ?? endpoint;
        if (status === "pending") {
          pending++;
          outstandingLabels.push(`${label} (${endpoint === "line_ownership" ? "unfinished sync" : "GitHub still computing"})`);
        } else if (status === "error") {
          errored++;
          // The reason matters more than the fact; without it the only way to find
          // out is to re-run and watch.
          outstandingLabels.push(`${label} — ${row?.error ?? "failed"}`);
        } else {
          outstandingLabels.push(`${label} (not attempted)`);
        }
      }

      const outstanding = endpoints.length - complete;
      out.set(repoId, {
        state: complete === 0 ? "never" : outstanding === 0 ? "complete" : "outstanding",
        complete,
        outstanding,
        pending,
        errored,
        detail: outstandingLabels.length
          ? `Outstanding:\n· ${outstandingLabels.join("\n· ")}`
          : "Everything selected is synced",
      });
    }
    return out;
  }, [statuses.data, repoIds, endpoints]);

  const syncRepo = useCallback(
    async (repoId: number, mode: SyncMode) => {
      if (!db || !token || !orgs.length || syncing) return;
      setActiveRepoId(repoId);
      setSyncing(true);
      try {
        await runSync({
          db,
          token,
          orgs,
          mode,
          endpoints,
          repoIds: [repoId],
          // A single repository may well be archived or quiet; the user asked for
          // it explicitly, so neither should exclude it.
          includeArchived: true,
          onProgress: setSync,
        });
        await reloadSyncTime();
        await queryClient.invalidateQueries();
      } finally {
        setSyncing(false);
        setActiveRepoId(null);
      }
    },
    [db, token, orgs, syncing, endpoints, setSyncing, setSync, reloadSyncTime, queryClient],
  );

  const retryPair = useCallback(
    async (repoId: number, endpoint: EndpointId) => {
      if (!db || !token || !orgs.length || syncing) return;
      setActivePair(`${repoId}:${endpoint}`);
      setSyncing(true);
      try {
        await runSync({
          db,
          token,
          orgs,
          // `full` rather than `resume`: the user is pointing at this exact item
          // and asking for it to be done now. Resume would reach the same result
          // for a pending or errored pair, but only by coincidence of it not being
          // terminal — being explicit means the button does what it says even if
          // the status changed underneath.
          mode: "full",
          endpoints: [endpoint],
          repoIds: [repoId],
          includeArchived: true,
          onProgress: setSync,
        });
        await reloadSyncTime();
        await queryClient.invalidateQueries();
      } finally {
        setSyncing(false);
        setActivePair(null);
      }
    },
    [db, token, orgs, syncing, setSyncing, setSync, reloadSyncTime, queryClient],
  );

  return {
    summaries,
    activeRepoId,
    activePair,
    busy: syncing,
    syncRepo,
    retryPair,
    refresh: () => void statuses.refetch(),
  };
}
