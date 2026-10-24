/**
 * Turning one commit from GitHub's history into the accounts the weekly stats
 * would count.
 *
 * `stats/contributors` credits the git author and every `Co-authored-by` trailer
 * GitHub could resolve, and it drops merge commits and empty ones. The GraphQL
 * `authors` connection is that same list — parsing the trailer here would miss
 * addresses only GitHub knows how to resolve, such as a personal email or an
 * agent's noreply address.
 */

/** Rows written by the commits list before co-authors and full history. */
export const COMMIT_LOG_LEGACY_FORMAT = 1;
/** Full history and co-authors, plus PR association for every commit. */
export const COMMIT_LOG_FORMAT = 3;

/** The fields the history query asks for. Anything else on the payload is ignored. */
export interface HistoryCommitNode {
  oid?: string | null;
  authoredDate?: string | null;
  /** Null when GitHub declined to count the files, which means the commit is large, not empty. */
  changedFilesIfAvailable?: number | null;
  parents?: { totalCount?: number | null } | null;
  associatedPullRequests?: { totalCount?: number | null } | null;
  authors?: {
    nodes?: Array<{ user?: { login?: string | null } | null } | null> | null;
  } | null;
}

export interface CreditedCommit {
  sha: string;
  /** Null for old or unavailable association data; never assume that means direct. */
  isPr: boolean | null;
  /**
   * Distinct accounts, in GitHub's casing. Empty when the commit is empty, its
   * date is unusable, or no author resolved to an account — the sha is still
   * returned so a previous row for it can be removed.
   */
  logins: string[];
  /** Unix seconds, 00:00 UTC of the author date. Null when the date cannot be read. */
  day: number | null;
}

const DAY_MS = 86_400_000;

/** UTC midnight of an author date, in unix seconds. */
export function authorDay(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / DAY_MS) * (DAY_MS / 1000);
}

/**
 * Accounts to store for one history node.
 *
 * Null for a merge: the work is already counted on the commits it brought in,
 * and a merge was never a row, so there is nothing to retract. Every other
 * commit comes back, including empty ones, so the caller can drop a row that
 * an earlier fetch stored.
 */
export function creditCommit(node: HistoryCommitNode | null | undefined): CreditedCommit | null {
  const sha = node?.oid;
  if (!sha) return null;
  if ((node?.parents?.totalCount ?? 0) > 1) return null;

  const count = node?.associatedPullRequests?.totalCount;
  const isPr = count == null ? null : count > 0;
  const day = authorDay(node?.authoredDate);
  // A zero file count is GitHub's empty commit. Null means the count was too
  // expensive to compute, and those commits are not empty.
  const empty = node?.changedFilesIfAvailable === 0;
  if (empty || day == null) return { sha, logins: [], day, isPr };

  const seen = new Map<string, string>();
  for (const author of node?.authors?.nodes ?? []) {
    const login = author?.user?.login?.trim();
    if (!login) continue;
    const key = login.toLowerCase();
    if (!seen.has(key)) seen.set(key, login);
  }
  return { sha, logins: [...seen.values()], day, isPr };
}
