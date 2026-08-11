import { useQuery } from "@tanstack/react-query";
import { useApp } from "./state/app";
import {
  getAuthorProbe,
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
 * `myCommits` merges them, preferring the synced figure when present.
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

  const mineMap = toMap(mine.data);
  const probeMap = new Map(
    (probe.data ?? []).filter((r) => r.readable === 1).map((r) => [r.repo_id, Number(r.commits)]),
  );

  const myCommits = new Map(probeMap);
  for (const [repoId, row] of mineMap) {
    const synced = Number(row.commits);
    if (synced > 0) myCommits.set(repoId, synced);
  }

  return {
    activity: toMap(activity.data),
    mine: mineMap,
    probe: probeMap,
    myCommits,
    hasProbe: (probe.data?.length ?? 0) > 0,
    login,
    loading: activity.isLoading || mine.isLoading || probe.isLoading,
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
