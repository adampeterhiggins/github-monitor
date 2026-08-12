import { useQuery } from "@tanstack/react-query";
import { useApp } from "./state/app";
import {
  getAuthorProbe,
  getRepoStats,
  repoActivity,
  reposContributedTo,
  type RepoActivityRow,
  type RepoRow,
} from "./db/queries";

/**
 * Per-repository activity for the selection UIs.
 *
 * Two independent sources of "commits by me", because they answer at different
 * times:
 *
 *  - `mine` comes from synced contributor stats. Rich, but only covers
 *    repositories that have already been synced.
 *  - `probe` comes from asking GitHub directly, one request per repository. Works
 *    from a cold cache, which is precisely when you need it — the point of
 *    choosing repositories is to avoid syncing all of them.
 *
 * `myCommits` merges them, preferring the synced figure when present. Repository
 * totals work the same way: `allCommits` prefers what a sync landed and falls back
 * to the pre-sync counts, which is the only figure available while deciding what to
 * sync in the first place.
 */
export interface RepoSelectionData {
  /** repo id -> activity across all contributors (synced). */
  activity: Map<number, RepoActivityRow>;
  /** repo id -> the signed-in user's activity (synced). */
  mine: Map<number, RepoActivityRow>;
  /** repo id -> the signed-in user's commit count from a direct probe. */
  probe: Map<number, number>;
  /** Best available per-repo commit count for the signed-in user. */
  myCommits: Map<number, number>;
  /** True once a probe has been run for this account. */
  hasProbe: boolean;
  /** repo id -> total commits from the pre-sync sweep. Absent means unchecked. */
  preSync: Map<number, { commits: number; recentCommits: number }>;
  /** Best available total commit count per repository, synced or pre-synced. */
  allCommits: Map<number, number>;
  /** When the pre-sync sweep last ran, or null if it never has. */
  preSyncAt: string | null;
  refetchPreSync: () => void;
  login: string | null;
  loading: boolean;
  /** True once a sync has produced commit data to reason about. */
  hasCommitData: boolean;
  refetchProbe: () => void;
}

const toMap = (rows: RepoActivityRow[] | undefined) =>
  new Map((rows ?? []).map((r) => [r.repo_id, r]));

export function useRepoSelectionData(): RepoSelectionData {
  const db = useApp((s) => s.db);
  const login = useApp((s) => s.login);
  const lastSyncAt = useApp((s) => s.lastSyncAt);
  const probeStamp = useApp((s) => s.probeStamp);

  const activity = useQuery({
    queryKey: ["repo-activity", lastSyncAt],
    enabled: db != null,
    queryFn: () => repoActivity(db!),
    staleTime: 60_000,
  });

  const mine = useQuery({
    queryKey: ["repo-activity-mine", login, lastSyncAt],
    enabled: db != null && login != null,
    queryFn: () => reposContributedTo(db!, login!),
    staleTime: 60_000,
  });

  const probe = useQuery({
    queryKey: ["author-probe", login, probeStamp],
    enabled: db != null && login != null,
    queryFn: () => getAuthorProbe(db!, login!),
    staleTime: 60_000,
  });

  // Keyed on the same stamp as the author probe: both are pre-sync sweeps whose
  // results the panel has to pick up as soon as one finishes.
  const stats = useQuery({
    queryKey: ["repo-stats", probeStamp],
    enabled: db != null,
    queryFn: () => getRepoStats(db!),
    staleTime: 60_000,
  });

  const mineMap = toMap(mine.data);
  const probeMap = new Map(
    (probe.data ?? []).filter((r) => r.readable === 1).map((r) => [r.repo_id, Number(r.commits)]),
  );

  const myCommits = new Map(probeMap);
  for (const [repoId, row] of mineMap) {
    const synced = Number(row.commits);
    if (synced > 0) myCommits.set(repoId, synced);
  }

  const preSync = new Map(
    (stats.data ?? [])
      .filter((r) => r.readable === 1 && r.commits != null)
      .map((r) => [
        r.repo_id,
        { commits: Number(r.commits), recentCommits: Number(r.recent_commits ?? 0) },
      ]),
  );

  const activityMap = toMap(activity.data);
  const allCommits = new Map([...preSync].map(([id, s]) => [id, s.commits]));
  for (const [repoId, row] of activityMap) {
    const synced = Number(row.commits);
    if (synced > 0) allCommits.set(repoId, synced);
  }

  const checkedAt = (stats.data ?? [])
    .map((r) => r.checked_at)
    .filter((t): t is string => t != null)
    .sort();

  return {
    activity: activityMap,
    mine: mineMap,
    probe: probeMap,
    myCommits,
    hasProbe: (probe.data?.length ?? 0) > 0,
    preSync,
    allCommits,
    preSyncAt: checkedAt.length ? checkedAt[checkedAt.length - 1] : null,
    refetchPreSync: () => void stats.refetch(),
    login,
    loading: activity.isLoading || mine.isLoading || probe.isLoading || stats.isLoading,
    hasCommitData: (activity.data?.length ?? 0) > 0,
    refetchProbe: () => void probe.refetch(),
  };
}

/** Repos pushed to within `months`, excluding archived. */
export function activeRepoIds(repos: RepoRow[], months = 12): number[] {
  const cutoff = new Date(Date.now() - months * 30 * 86_400_000).toISOString();
  return repos.filter((r) => r.archived === 0 && (r.pushed_at ?? "") >= cutoff).map((r) => r.id);
}

/** Repos where the signed-in user has at least one commit, from either source. */
export function myRepoIds(repos: RepoRow[], myCommits: Map<number, number>): number[] {
  return repos.filter((r) => (myCommits.get(r.id) ?? 0) > 0).map((r) => r.id);
}
