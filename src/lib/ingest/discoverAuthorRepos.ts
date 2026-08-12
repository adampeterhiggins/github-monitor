import type Database from "@tauri-apps/plugin-sql";
import { GitHubClient } from "../github/client";
import { commitCount } from "../github/endpoints";
import { saveAuthorProbe } from "../db/queries";
import type { RepoRow } from "../db/queries";

/**
 * Discover which repositories a person has committed to, without needing a sync.
 *
 * This exists because the obvious implementations do not work:
 *
 *  - Reading the local cache is circular. The cache is only populated by syncing,
 *    but the reason to pick repositories is to avoid syncing all of them. On a
 *    cold cache the answer is simply "the one repository you already synced".
 *  - GraphQL `contributionsCollection` withholds private-repository contributions,
 *    reporting them only as an opaque `restrictedContributionsCount` (measured at
 *    5,366 hidden versus 5 visible on the target account), so it is useless for a
 *    private org.
 *  - `search/commits` returns a total but caps retrievable results at 1,000, so
 *    enumerating every repository from it is not reliable.
 *
 * So it asks GitHub per repository, which is definitive. Each probe is a single
 * request thanks to the `per_page=1` + Link rel="last" trick, so the whole sweep
 * costs one request per repository against a 5,000/hour budget.
 */

export interface DiscoverProgress {
  done: number;
  total: number;
  current: string | null;
  /** Repositories found to have at least one commit so far. */
  found: number;
}

export interface DiscoverResult {
  /** Repo ids with at least one commit by this person. */
  repoIds: number[];
  /** repo id -> commit count, including zeros, for display. */
  counts: Map<number, number>;
  /** Repositories that could not be read (empty repo, or no access). */
  unreadable: number[];
  cancelled: boolean;
  requestsMade: number;
}

export interface DiscoverOptions {
  db: Database;
  token: string;
  login: string;
  /** Candidate repositories to probe; the caller decides about archived ones. */
  repos: RepoRow[];
  /** Only count commits at or after this ISO timestamp. */
  since?: string;
  onProgress?: (p: DiscoverProgress) => void;
  signal?: AbortSignal;
}

export async function discoverAuthorRepos(options: DiscoverOptions): Promise<DiscoverResult> {
  const { db, token, login, repos, since, signal } = options;

  const client = new GitHubClient({ token, concurrency: 8 });
  const counts = new Map<number, number>();
  const unreadable: number[] = [];
  let done = 0;
  let found = 0;
  let requestsMade = 0;
  let current: string | null = null;

  const emit = () => options.onProgress?.({ done, total: repos.length, current, found });
  emit();

  // Bounded parallelism; the client's own semaphore caps actual sockets.
  const concurrency = Math.min(8, repos.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor++;
      if (index >= repos.length) return;
      const repo = repos[index];
      current = repo.full_name;
      try {
        const count = await commitCount(
          client,
          { owner: repo.owner, name: repo.name },
          { author: login, signal, since },
        );
        requestsMade++;
        if (count == null) {
          unreadable.push(repo.id);
        } else {
          counts.set(repo.id, count);
          if (count > 0) found++;
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        // A single unreachable repository must not abort the sweep.
        unreadable.push(repo.id);
      } finally {
        done++;
        emit();
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  const cancelled = signal?.aborted === true;

  // Persist whatever was learned, even on cancellation — partial results are
  // still useful and save requests next time.
  await saveAuthorProbe(
    db,
    login,
    [
      ...[...counts.entries()].map(([repoId, c]) => ({ repoId, commits: c, readable: true })),
      ...unreadable.map((repoId) => ({ repoId, commits: 0, readable: false })),
    ],
  );

  return {
    repoIds: [...counts.entries()].filter(([, c]) => c > 0).map(([id]) => id),
    counts,
    unreadable,
    cancelled,
    requestsMade,
  };
}
