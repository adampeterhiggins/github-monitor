import type Database from "@tauri-apps/plugin-sql";
import type { GitHubClient } from "../github/client";
import { bulkInsert, withWriteLock } from "../db";

/**
 * Pulse has no dedicated REST endpoint, so it is derived from pull requests and
 * issues. GraphQL is used rather than REST search because it returns the review
 * and comment counts in the same round trip, and because GraphQL's `issues`
 * connection excludes pull requests (REST's `/issues` conflates the two).
 */

interface PulseRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
}

interface PrNode {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
  author: { login: string } | null;
  comments: { totalCount: number };
  reviews: { totalCount: number };
}

interface IssueNode {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: { login: string } | null;
  comments: { totalCount: number };
}

interface Connection<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

type PrPage = { repository: { pullRequests: Connection<PrNode> } | null };
type IssuePage = { repository: { issues: Connection<IssueNode> } | null };

const PR_QUERY = `
query PullRequests($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state
        createdAt
        updatedAt
        mergedAt
        closedAt
        additions
        deletions
        author { login }
        comments { totalCount }
        reviews { totalCount }
      }
    }
  }
}`;

const ISSUE_QUERY = `
query Issues($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state
        createdAt
        updatedAt
        closedAt
        author { login }
        comments { totalCount }
      }
    }
  }
}`;

/** Safety rail: 20 pages is 2,000 records per repo per type. */
const MAX_PAGES = 20;

export interface SyncPulseOptions {
  client: GitHubClient;
  db: Database;
  repos: PulseRepo[];
  /** Stop paginating once records were last updated before this timestamp. */
  sinceIso: string;
  /** Optional per-repository checkpoints used by incremental refreshes. */
  sinceIsoByRepo?: ReadonlyMap<number, string>;
  signal?: AbortSignal;
  onRepoDone?: (fullName: string) => void | Promise<void>;
  onError?: (fullName: string, message: string) => void;
}

export async function syncPulse(options: SyncPulseOptions): Promise<void> {
  const { client, db, repos, sinceIso, sinceIsoByRepo, signal } = options;

  // GraphQL is heavier per call than REST, so keep the fan-out modest.
  const concurrency = 4;
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, repos.length) }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = cursor++;
      if (i >= repos.length) return;
      const repo = repos[i];
      try {
        await syncRepoPulse(client, db, repo, sinceIsoByRepo?.get(repo.id) ?? sinceIso, signal);
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") {
          options.onError?.(repo.fullName, (err as Error)?.message ?? String(err));
        }
      } finally {
        await options.onRepoDone?.(repo.fullName);
      }
    }
  });

  await Promise.all(workers);
}

async function syncRepoPulse(
  client: GitHubClient,
  db: Database,
  repo: PulseRepo,
  sinceIso: string,
  signal?: AbortSignal,
): Promise<void> {
  const prRows: unknown[][] = [];
  const issueRows: unknown[][] = [];

  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal?.aborted) return;
    const data: PrPage = await client.graphql<PrPage>(
      PR_QUERY,
      { owner: repo.owner, name: repo.name, cursor },
      { signal },
    );
    const conn: Connection<PrNode> | undefined = data.repository?.pullRequests;
    if (!conn) break;

    let reachedCutoff = false;
    for (const pr of conn.nodes) {
      if (pr.updatedAt < sinceIso) {
        // Ordered by last update, so the first old record ends the walk. Keep it
        // to make the cutoff inclusive and harmlessly overlap adjacent runs.
        reachedCutoff = true;
      }
      prRows.push([
        repo.id,
        pr.number,
        pr.author?.login ?? null,
        pr.title,
        pr.state,
        pr.createdAt,
        pr.mergedAt,
        pr.closedAt,
        pr.additions ?? 0,
        pr.deletions ?? 0,
        pr.comments?.totalCount ?? 0,
        pr.reviews?.totalCount ?? 0,
      ]);
    }
    if (reachedCutoff || !conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal?.aborted) return;
    const data: IssuePage = await client.graphql<IssuePage>(
      ISSUE_QUERY,
      { owner: repo.owner, name: repo.name, cursor },
      { signal },
    );
    const conn: Connection<IssueNode> | undefined = data.repository?.issues;
    if (!conn) break;

    let reachedCutoff = false;
    for (const issue of conn.nodes) {
      if (issue.updatedAt < sinceIso) reachedCutoff = true;
      issueRows.push([
        repo.id,
        issue.number,
        issue.author?.login ?? null,
        issue.title,
        issue.state,
        issue.createdAt,
        issue.closedAt,
        issue.comments?.totalCount ?? 0,
      ]);
    }
    if (reachedCutoff || !conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  // Serialised against the other concurrent repo writers; see ../db/index.ts.
  await withWriteLock(async () => {
    await bulkInsert(db, {
      table: "pull_requests",
      columns: [
        "repo_id",
        "number",
        "author",
        "title",
        "state",
        "created_at",
        "merged_at",
        "closed_at",
        "additions",
        "deletions",
        "comments",
        "reviews",
      ],
      conflictColumns: ["repo_id", "number"],
      rows: prRows,
    });

    await bulkInsert(db, {
      table: "issues",
      columns: [
        "repo_id",
        "number",
        "author",
        "title",
        "state",
        "created_at",
        "closed_at",
        "comments",
      ],
      conflictColumns: ["repo_id", "number"],
      rows: issueRows,
    });
  });
}
