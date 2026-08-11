import { useQuery } from "@tanstack/react-query";
import { useApp } from "./state/app";
import { repoActivity, reposContributedTo, type RepoActivityRow, type RepoRow } from "./db/queries";

/**
 * Per-repository activity used by the selection UIs: total commits, and how many
 * of them are the signed-in user's.
 *
 * Both come from the local cache rather than the API, so the presets are instant
 * and cost no rate limit. The trade-off is that they only know about repositories
 * that have been synced — callers surface that when a preset comes back empty.
 */
export interface RepoSelectionData {
  /** repo id -> activity across all contributors. */
  activity: Map<number, RepoActivityRow>;
  /** repo id -> the signed-in user's own activity. */
  mine: Map<number, RepoActivityRow>;
  login: string | null;
  loading: boolean;
  /** True once a sync has produced commit data to reason about. */
  hasCommitData: boolean;
}

const toMap = (rows: RepoActivityRow[] | undefined) =>
  new Map((rows ?? []).map((r) => [r.repo_id, r]));

export function useRepoSelectionData(): RepoSelectionData {
  const db = useApp((s) => s.db);
  const login = useApp((s) => s.login);
  const lastSyncAt = useApp((s) => s.lastSyncAt);

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

  return {
    activity: toMap(activity.data),
    mine: toMap(mine.data),
    login,
    loading: activity.isLoading || mine.isLoading,
    hasCommitData: (activity.data?.length ?? 0) > 0,
  };
}

/** Repos pushed to within `months`, excluding archived. */
export function activeRepoIds(repos: RepoRow[], months = 12): number[] {
  const cutoff = new Date(Date.now() - months * 30 * 86_400_000).toISOString();
  return repos.filter((r) => r.archived === 0 && (r.pushed_at ?? "") >= cutoff).map((r) => r.id);
}

/** Repos the signed-in user has at least one cached commit in. */
export function myRepoIds(repos: RepoRow[], mine: Map<number, RepoActivityRow>): number[] {
  return repos.filter((r) => (mine.get(r.id)?.commits ?? 0) > 0).map((r) => r.id);
}
