import type Database from "@tauri-apps/plugin-sql";
import { GitHubClient, GitHubError, StatsPendingError, type RateLimitState } from "../github/client";
import * as api from "../github/endpoints";
import { recordSync, setMeta, type SyncStatus } from "../db";
import * as write from "./writers";
import { syncPulse } from "./pulse";
import type {
  GhCodeFrequency,
  GhCommitActivity,
  GhContributorStats,
  GhParticipation,
  GhPunchCard,
  GhRepo,
} from "../github/types";

export type EndpointId =
  | "contributors"
  | "commit_activity"
  | "participation"
  | "code_frequency"
  | "punchcard"
  | "traffic"
  | "community"
  | "forks"
  | "branches"
  | "dependencies"
  | "actions"
  | "pulse";

export const ALL_ENDPOINTS: EndpointId[] = [
  "contributors",
  "commit_activity",
  "participation",
  "code_frequency",
  "punchcard",
  "traffic",
  "community",
  "forks",
  "branches",
  "dependencies",
  "actions",
  "pulse",
];

/** The subset that GitHub computes lazily and answers with 202 while cold. */
const STATS_ENDPOINTS = [
  "contributors",
  "commit_activity",
  "participation",
  "code_frequency",
  "punchcard",
] as const;

export const ENDPOINT_LABELS: Record<EndpointId, string> = {
  contributors: "Contributor stats",
  commit_activity: "Commit activity",
  participation: "Participation",
  code_frequency: "Code frequency",
  punchcard: "Punch card",
  traffic: "Traffic",
  community: "Community profile",
  forks: "Forks",
  branches: "Branches",
  dependencies: "Dependencies",
  actions: "Actions runs",
  pulse: "Pull requests & issues",
};

export interface SyncError {
  repo: string;
  endpoint: EndpointId;
  message: string;
  kind: "pending" | "forbidden" | "error";
}

export interface SyncProgress {
  phase: "repos" | "warming" | "collecting" | "extras" | "pulse" | "done" | "cancelled";
  label: string;
  done: number;
  total: number;
  current: string | null;
  errors: SyncError[];
  rateLimit: RateLimitState | null;
  /** Set while parked on a rate limit, so the UI can explain the pause. */
  throttleMs: number | null;
  /** Items skipped because a previous run already finished them. */
  skipped: number;
  mode: SyncMode;
}

/**
 * `resume` skips work already recorded as finished, so an interrupted sync can be
 * picked up without repeating it. `full` ignores that record and re-fetches
 * everything, which is what you want when the data itself has gone stale.
 */
export type SyncMode = "resume" | "full";

/**
 * Statuses that count as finished for a (repository, endpoint) pair.
 *
 * `empty` and `forbidden` are included deliberately: a repository with no commits
 * will still have none, and one the token cannot read will still be unreadable, so
 * retrying them on every resume would burn requests to learn nothing. Both are
 * revisited by a full sync — which is also what to run after changing the token.
 */
const TERMINAL_STATUSES: ReadonlySet<SyncStatus> = new Set<SyncStatus>([
  "ok",
  "empty",
  "forbidden",
]);

/**
 * Whether a (repository, endpoint) pair can be skipped this run.
 *
 * Exported so the decision is testable in isolation: skipping something that did
 * not actually finish would leave a permanent hole that no later resume would fill,
 * which is the one way this feature can quietly lose data.
 *
 * @param status the recorded outcome, or undefined if never attempted
 */
export function shouldSkip(status: SyncStatus | undefined, mode: SyncMode): boolean {
  if (mode === "full") return false;
  if (status === undefined) return false;
  return TERMINAL_STATUSES.has(status);
}

export interface SyncOptions {
  db: Database;
  token: string;
  org: string;
  endpoints?: EndpointId[];
  /** Restrict to these repo ids; defaults to every non-archived repo. */
  repoIds?: number[];
  includeArchived?: boolean;
  /** Skip repos with no pushes since this ISO date. */
  activeSince?: string | null;
  /** How far back to pull PR/issue/Actions data. */
  historyDays?: number;
  /** Defaults to `full`; the UI passes `resume` to continue an interrupted sync. */
  mode?: SyncMode;
  onProgress?: (p: SyncProgress) => void;
  signal?: AbortSignal;
}

export interface SyncResult {
  reposSynced: number;
  errors: SyncError[];
  cancelled: boolean;
  durationMs: number;
  /** Items skipped because a previous run already finished them. */
  skipped: number;
  /** Items actually fetched this run. */
  attempted: number;
  mode: SyncMode;
}

/** Run `fn` over `items` with bounded parallelism, preserving input order in the result. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

interface RepoTarget {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  hasCommits: boolean;
  canPush: boolean;
}

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const started = Date.now();
  const {
    db,
    token,
    org,
    endpoints = ALL_ENDPOINTS,
    includeArchived = false,
    activeSince = null,
    historyDays = 365,
    mode = "full",
    signal,
  } = options;

  const errors: SyncError[] = [];
  let rateLimit: RateLimitState | null = null;
  let throttleMs: number | null = null;
  let phase: SyncProgress["phase"] = "repos";
  let label = "Listing repositories";
  let done = 0;
  let total = 0;
  let current: string | null = null;
  let skipped = 0;
  let attempted = 0;

  const emit = () =>
    options.onProgress?.({
      phase,
      label,
      done,
      total,
      current,
      errors: [...errors],
      rateLimit,
      throttleMs,
      skipped,
      mode,
    });

  const client = new GitHubClient({
    token,
    concurrency: 6,
    events: {
      onRateLimit: (state) => {
        rateLimit = state;
      },
      onThrottle: (info) => {
        throttleMs = info.waitMs;
        label = `Paused: ${info.reason} — resuming in ${Math.ceil(info.waitMs / 1000)}s`;
        emit();
      },
      onStatsPending: () => {
        throttleMs = null;
      },
    },
  });

  const cancelled = () => signal?.aborted === true;
  const noteError = (repo: string, endpoint: EndpointId, err: unknown) => {
    if (err instanceof StatsPendingError) {
      errors.push({ repo, endpoint, message: "GitHub still computing; will retry next sync", kind: "pending" });
    } else if (err instanceof GitHubError && err.status === 403) {
      errors.push({ repo, endpoint, message: "No access (needs push permission)", kind: "forbidden" });
    } else if ((err as Error)?.name === "AbortError") {
      // Cancellation is not an error.
    } else {
      errors.push({ repo, endpoint, message: (err as Error)?.message ?? String(err), kind: "error" });
    }
  };

  emit();

  /* ── 1. Repository inventory ───────────────────────────────────────────── */

  let repos: GhRepo[];
  try {
    repos = await api.listOrgRepos(client, org, signal);
  } catch (err) {
    if (cancelled()) {
      return {
        reposSynced: 0,
        errors,
        cancelled: true,
        durationMs: Date.now() - started,
        skipped,
        attempted,
        mode,
      };
    }
    throw err;
  }
  await write.writeRepos(db, org, repos);

  const targets: RepoTarget[] = repos
    .filter((r) => (includeArchived ? true : !r.archived))
    .filter((r) => !r.disabled)
    .filter((r) => (options.repoIds ? options.repoIds.includes(r.id) : true))
    .filter((r) => (activeSince ? (r.pushed_at ?? "") >= activeSince : true))
    .map((r) => ({
      id: r.id,
      owner: org,
      name: r.name,
      fullName: r.full_name,
      // A zero-byte repo has no commits, so an empty stats payload is real, not pending.
      hasCommits: (r.size ?? 0) > 0 && r.pushed_at != null,
      canPush: r.permissions?.push === true,
    }));

  if (cancelled()) {
    phase = "cancelled";
    emit();
    return finish(true);
  }

  /* ── 1b. What is already done ──────────────────────────────────────────
     sync_state records the outcome of every (repository, endpoint) pair as it
     completes, including on cancellation, so an interrupted run leaves an
     accurate record of what it got through. In `resume` mode that record is
     consulted and finished work is skipped; in `full` mode it is ignored. */

  const doneAlready = new Set<string>();
  if (mode === "resume") {
    const rows = await db.select<Array<{ repo_id: number; endpoint: string; status: SyncStatus }>>(
      "SELECT repo_id, endpoint, status FROM sync_state",
    );
    for (const row of rows) {
      if (shouldSkip(row.status, mode)) doneAlready.add(`${row.repo_id}:${row.endpoint}`);
    }
  }

  /** True when a previous run finished this pair and we are resuming. */
  const isDone = (repoId: number, endpoint: EndpointId | string) =>
    doneAlready.has(`${repoId}:${endpoint}`);

  const statsWanted = STATS_ENDPOINTS.filter((e) => endpoints.includes(e));

  /* ── 2. Warm phase ─────────────────────────────────────────────────────
     Fire one request per repo/endpoint without polling. GitHub starts a
     background job per (repo, endpoint) and computes them concurrently, so by
     the time the collect pass comes round most caches are hot. Polling each
     repo to completion in turn would serialise all of that waiting. Anything
     that answers 200 immediately is written here and skipped later.        */

  interface WarmKey {
    repo: RepoTarget;
    endpoint: (typeof STATS_ENDPOINTS)[number];
  }
  const warmKeys: WarmKey[] = [];
  for (const repo of targets) {
    for (const endpoint of statsWanted) {
      if (isDone(repo.id, endpoint)) {
        skipped++;
        continue;
      }
      warmKeys.push({ repo, endpoint });
    }
  }

  const settled = new Set<string>();
  const keyOf = (r: RepoTarget, e: string) => `${r.id}:${e}`;

  if (warmKeys.length) {
    phase = "warming";
    label = "Asking GitHub to compute statistics";
    total = warmKeys.length;
    done = 0;
    emit();

    await pool(warmKeys, 8, async ({ repo, endpoint }) => {
      if (cancelled()) return;
      attempted++;
      current = repo.fullName;
      try {
        const res = await client.request<unknown>(statsPath(repo, endpoint), {
          signal,
          allowNotFound: true,
          allowForbidden: true,
        });
        // A repo with commits that answers 200 with an empty payload is still
        // warming, not genuinely empty — leave it for the collect pass rather than
        // recording a false "ok" that would render as no activity.
        const looksEmpty =
          res.data == null ||
          (Array.isArray(res.data) && res.data.length === 0) ||
          (typeof res.data === "object" && Object.keys(res.data as object).length === 0);

        if (res.status === 200 && !(looksEmpty && repo.hasCommits)) {
          const wrote = await persistStats(db, repo, endpoint, res.data);
          if (wrote) {
            settled.add(keyOf(repo, endpoint));
            await recordSync(db, repo.id, endpoint, looksEmpty ? "empty" : "ok", { etag: res.etag });
          }
        } else if (res.status === 204 || res.status === 404) {
          settled.add(keyOf(repo, endpoint));
          await recordSync(db, repo.id, endpoint, "empty");
        } else if (res.status === 403) {
          settled.add(keyOf(repo, endpoint));
          await recordSync(db, repo.id, endpoint, "forbidden");
        }
        // 202 deliberately left unsettled for the collect pass.
      } catch (err) {
        if (!cancelled()) noteError(repo.fullName, endpoint, err);
        settled.add(keyOf(repo, endpoint));
      } finally {
        done++;
        throttleMs = null;
        emit();
      }
    });
  }

  /* ── 3. Collect phase — poll whatever was still computing ──────────────── */

  const pendingKeys = warmKeys.filter(({ repo, endpoint }) => !settled.has(keyOf(repo, endpoint)));
  if (pendingKeys.length && !cancelled()) {
    phase = "collecting";
    label = "Collecting computed statistics";
    total = pendingKeys.length;
    done = 0;
    emit();

    await pool(pendingKeys, 6, async ({ repo, endpoint }) => {
      if (cancelled()) return;
      current = repo.fullName;
      try {
        const data = await fetchStats(client, repo, endpoint, signal);
        if (data == null) {
          await recordSync(db, repo.id, endpoint, "empty");
        } else {
          await persistStats(db, repo, endpoint, data);
          await recordSync(db, repo.id, endpoint, "ok");
        }
      } catch (err) {
        if (!cancelled()) {
          noteError(repo.fullName, endpoint, err);
          const status: SyncStatus = err instanceof StatsPendingError ? "pending" : "error";
          await recordSync(db, repo.id, endpoint, status, { error: (err as Error)?.message });
        }
      } finally {
        done++;
        emit();
      }
    });
  }

  /* ── 4. Everything that is a plain GET ─────────────────────────────────── */

  const extras = endpoints.filter((e) =>
    (["traffic", "community", "forks", "branches", "dependencies", "actions"] as EndpointId[]).includes(e),
  );

  if (extras.length && !cancelled()) {
    phase = "extras";
    label = "Fetching traffic, community and repository detail";
    total = targets.length * extras.length;
    done = 0;
    emit();

    const sinceIso = new Date(Date.now() - historyDays * 86_400_000).toISOString().slice(0, 10);

    await pool(targets, 6, async (repo) => {
      for (const endpoint of extras) {
        if (cancelled()) return;
        if (isDone(repo.id, endpoint)) {
          skipped++;
          done++;
          emit();
          continue;
        }
        attempted++;
        current = repo.fullName;
        try {
          await syncExtra(client, db, repo, endpoint, sinceIso, signal);
          await recordSync(db, repo.id, endpoint, "ok");
        } catch (err) {
          if (!cancelled()) {
            noteError(repo.fullName, endpoint, err);
            await recordSync(db, repo.id, endpoint, "error", { error: (err as Error)?.message });
          }
        } finally {
          done++;
          emit();
        }
      }
    });
  }

  /* ── 5. Pulse (PRs and issues, via GraphQL) ────────────────────────────── */

  if (endpoints.includes("pulse") && !cancelled()) {
    phase = "pulse";
    label = "Fetching pull requests and issues";

    const pulseTargets = targets.filter((r) => {
      if (!isDone(r.id, "pulse")) return true;
      skipped++;
      return false;
    });

    total = pulseTargets.length;
    done = 0;
    current = null;
    emit();

    // Pulse previously recorded nothing in sync_state, so it re-fetched every
    // repository on every run and could never resume. It is recorded per
    // repository now, which is also the granularity at which it can be resumed.
    const failedRepos = new Set<string>();
    const idByFullName = new Map(pulseTargets.map((r) => [r.fullName, r.id]));

    await syncPulse({
      client,
      db,
      repos: pulseTargets.map((r) => ({
        id: r.id,
        owner: r.owner,
        name: r.name,
        fullName: r.fullName,
      })),
      sinceIso: new Date(Date.now() - historyDays * 86_400_000).toISOString(),
      signal,
      onRepoDone: (fullName) => {
        done++;
        attempted++;
        current = fullName;
        const repoId = idByFullName.get(fullName);
        if (repoId != null && !cancelled()) {
          // Fire and forget: a bookkeeping write must not stall the sweep.
          void recordSync(db, repoId, "pulse", failedRepos.has(fullName) ? "error" : "ok");
        }
        emit();
      },
      onError: (fullName, message) => {
        failedRepos.add(fullName);
        errors.push({ repo: fullName, endpoint: "pulse", message, kind: "error" });
      },
    });
  }

  await setMeta(db, "last_sync_at", new Date().toISOString());
  await setMeta(db, "last_sync_org", org);

  phase = cancelled() ? "cancelled" : "done";
  label = cancelled() ? "Sync cancelled" : "Sync complete";
  current = null;
  throttleMs = null;
  emit();

  return finish(cancelled());

  function finish(wasCancelled: boolean): SyncResult {
    return {
      reposSynced: targets?.length ?? 0,
      errors,
      cancelled: wasCancelled,
      durationMs: Date.now() - started,
      skipped,
      attempted,
      mode,
    };
  }
}

/* ── endpoint plumbing ──────────────────────────────────────────────────── */

function statsPath(repo: RepoTarget, endpoint: (typeof STATS_ENDPOINTS)[number]): string {
  const base = `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/stats`;
  switch (endpoint) {
    case "contributors":
      return `${base}/contributors`;
    case "commit_activity":
      return `${base}/commit_activity`;
    case "participation":
      return `${base}/participation`;
    case "code_frequency":
      return `${base}/code_frequency`;
    case "punchcard":
      return `${base}/punch_card`;
  }
}

function fetchStats(
  client: GitHubClient,
  repo: RepoTarget,
  endpoint: (typeof STATS_ENDPOINTS)[number],
  signal?: AbortSignal,
): Promise<unknown> {
  const ref = { owner: repo.owner, name: repo.name };
  const opts = { signal, hasCommits: repo.hasCommits };
  switch (endpoint) {
    case "contributors":
      return api.contributorStats(client, ref, opts);
    case "commit_activity":
      return api.commitActivity(client, ref, opts);
    case "participation":
      return api.participation(client, ref, { signal });
    case "code_frequency":
      return api.codeFrequency(client, ref, opts);
    case "punchcard":
      return api.punchCard(client, ref, { signal });
  }
}

/** Returns false when the payload was not the expected shape, so the caller keeps polling. */
async function persistStats(
  db: Database,
  repo: RepoTarget,
  endpoint: (typeof STATS_ENDPOINTS)[number],
  data: unknown,
): Promise<boolean> {
  switch (endpoint) {
    case "contributors": {
      if (!Array.isArray(data)) return false;
      await write.writeContributorStats(db, repo.id, data as GhContributorStats[]);
      return true;
    }
    case "commit_activity": {
      if (!Array.isArray(data)) return false;
      await write.writeCommitActivity(db, repo.id, data as GhCommitActivity[]);
      return true;
    }
    case "participation": {
      const p = data as GhParticipation;
      if (!p || !Array.isArray(p.all)) return false;
      await write.writeParticipation(db, repo.id, p);
      return true;
    }
    case "code_frequency": {
      if (!Array.isArray(data)) return false;
      await write.writeCodeFrequency(db, repo.id, data as GhCodeFrequency[]);
      return true;
    }
    case "punchcard": {
      if (!Array.isArray(data)) return false;
      await write.writePunchCard(db, repo.id, data as GhPunchCard[]);
      return true;
    }
  }
}

async function syncExtra(
  client: GitHubClient,
  db: Database,
  repo: RepoTarget,
  endpoint: EndpointId,
  sinceIso: string,
  signal?: AbortSignal,
): Promise<void> {
  const ref = { owner: repo.owner, name: repo.name };
  switch (endpoint) {
    case "traffic": {
      // Traffic needs push access; without it GitHub answers 403 and we skip quietly.
      if (!repo.canPush) return;
      const [views, clones, paths, referrers] = await Promise.all([
        api.trafficViews(client, ref, signal),
        api.trafficClones(client, ref, signal),
        api.trafficPaths(client, ref, signal),
        api.trafficReferrers(client, ref, signal),
      ]);
      await write.writeTraffic(db, repo.id, views, clones);
      await write.writeTrafficBreakdown(db, repo.id, paths, referrers);
      return;
    }
    case "community": {
      const profile = await api.communityProfile(client, ref, signal);
      if (profile) await write.writeCommunity(db, repo.id, profile);
      return;
    }
    case "forks": {
      const forks = await api.listForks(client, ref, signal);
      await write.writeForks(db, repo.id, forks);
      return;
    }
    case "branches": {
      const branches = await api.listBranches(client, ref, signal);
      await write.writeBranches(db, repo.id, branches);
      return;
    }
    case "dependencies": {
      const payload = await api.sbom(client, ref, signal);
      if (payload) await write.writeDependencies(db, repo.id, payload);
      return;
    }
    case "actions": {
      const runs = await api.listWorkflowRuns(client, ref, sinceIso, { signal, maxPages: 3 });
      await write.writeWorkflowRuns(db, repo.id, runs);
      return;
    }
    default:
      return;
  }
}
