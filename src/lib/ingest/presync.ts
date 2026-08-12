import type Database from "@tauri-apps/plugin-sql";
import { GitHubClient } from "../github/client";
import { commitCount } from "../github/endpoints";
import { saveRepoStats } from "../db/queries";
import type { RepoRow } from "../db/queries";

/**
 * Cheap per-repository commit counts, fetched before deciding what to fully sync.
 *
 * A full sync is expensive: a dozen endpoints per repository, five of which GitHub
 * computes lazily and answers 202 for until they are warm. Running it across a few
 * hundred repositories to discover that most of them are dormant is the wrong order
 * of operations — but nothing in the cache can tell you which are dormant until you
 * have synced them, and `pushed_at` alone cannot distinguish a repository that took
 * one README commit last week from one that took five hundred.
 *
 * So this asks GitHub directly, twice per repository: how many commits are there at
 * all, and how many since a cutoff. Both are single requests (see `commitCount`),
 * so a 300-repository org costs 600 of the 5,000/hour budget and takes under a
 * minute — against the hours a blanket full sync would take.
 *
 * It is deliberately independent of `runSync`: it writes only `repo_stats`, records
 * no `sync_state`, and never warms a stats cache. Running it changes nothing about
 * what a later sync will do.
 */

export interface PreSyncProgress {
  done: number;
  total: number;
  current: string | null;
  /** Repositories found to have at least one commit in the window so far. */
  active: number;
}

export interface PreSyncStats {
  repoId: number;
  /** Total commits on the default branch; null when the repository is unreadable. */
  commits: number | null;
  recentCommits: number | null;
}

export interface PreSyncResult {
  /** repo id -> counts, for repositories that could be read. */
  stats: Map<number, PreSyncStats>;
  /** Repositories that could not be read (empty repo, no access). */
  unreadable: number[];
  /** The cutoff `recentCommits` was counted from. */
  since: string;
  cancelled: boolean;
  requestsMade: number;
}

export interface PreSyncOptions {
  db: Database;
  token: string;
  /** Candidate repositories; the caller decides about archived ones. */
  repos: RepoRow[];
  /** How far back the "recent" count reaches. Defaults to a year. */
  sinceDays?: number;
  onProgress?: (p: PreSyncProgress) => void;
  signal?: AbortSignal;
}

export async function runPreSync(options: PreSyncOptions): Promise<PreSyncResult> {
  const { db, token, repos, sinceDays = 365, signal } = options;
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  const client = new GitHubClient({ token, concurrency: 8 });
  const stats = new Map<number, PreSyncStats>();
  const unreadable: number[] = [];
  let done = 0;
  let active = 0;
  let requestsMade = 0;
  let current: string | null = null;

  const emit = () => options.onProgress?.({ done, total: repos.length, current, active });
  emit();

  const concurrency = Math.min(8, repos.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor++;
      if (index >= repos.length) return;

      const repo = repos[index];
      const ref = { owner: repo.owner, name: repo.name };
      current = repo.full_name;

      try {
        const total = await commitCount(client, ref, { signal });
        requestsMade++;

        if (total == null) {
          // Unreadable, so the second request would only learn the same thing.
          unreadable.push(repo.id);
        } else {
          const recent = await commitCount(client, ref, { signal, since });
          requestsMade++;
          stats.set(repo.id, { repoId: repo.id, commits: total, recentCommits: recent ?? 0 });
          if ((recent ?? 0) > 0) active++;
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        // One unreachable repository must not abort the sweep.
        unreadable.push(repo.id);
      } finally {
        done++;
        emit();
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  // Persist whatever was learned, including on cancellation: a partial answer is
  // still worth having, and it saves the requests next time.
  await saveRepoStats(db, [
    ...[...stats.values()].map((s) => ({
      repoId: s.repoId,
      commits: s.commits,
      recentCommits: s.recentCommits,
      since,
      readable: true,
    })),
    ...unreadable.map((repoId) => ({
      repoId,
      commits: null,
      recentCommits: null,
      since,
      readable: false,
    })),
  ]);

  return {
    stats,
    unreadable,
    since,
    cancelled: signal?.aborted === true,
    requestsMade,
  };
}
