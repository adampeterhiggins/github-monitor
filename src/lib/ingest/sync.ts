import type Database from "@tauri-apps/plugin-sql";
import {
  GitHubClient,
  GitHubError,
  StatsPendingError,
  statsRetryDelay,
  type RateLimitState,
} from "../github/client";
import * as api from "../github/endpoints";
import { recordSync, setMeta, type SyncStatus } from "../db";
import * as write from "./writers";
import { syncOwnershipRepo } from "./lineOwnership";
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
  | "pulse"
  | "line_ownership";

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
  "line_ownership",
];

/** The subset that GitHub computes lazily and answers with 202 while cold. */
const STATS_ENDPOINTS = [
  "contributors",
  "commit_activity",
  "participation",
  "code_frequency",
  "punchcard",
] as const;

/** Stats payloads where a commit-bearing repository can transiently answer 200 + []. */
const EMPTY_STATS_ARE_PENDING: ReadonlySet<(typeof STATS_ENDPOINTS)[number]> = new Set([
  "contributors",
  "commit_activity",
  "code_frequency",
]);

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
  line_ownership: "Line ownership",
};

export interface SyncError {
  repo: string;
  endpoint: EndpointId;
  message: string;
  kind: "pending" | "forbidden" | "error";
}

export interface SyncProgress {
  phase: "repos" | "warming" | "syncing" | "collecting" | "extras" | "pulse" | "done" | "cancelled";
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
 * picked up without repeating it. `incremental` refreshes only data that can have
 * changed since each endpoint last succeeded. `full` ignores all checkpoints and
 * is reserved for explicit recovery operations such as changing token scopes.
 */
export type SyncMode = "resume" | "incremental" | "full";

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
  if (mode !== "resume") return false;
  if (status === undefined) return false;
  return TERMINAL_STATUSES.has(status);
}

export interface IncrementalState {
  status: SyncStatus;
  lastOkAt: string | null;
  lastAttemptAt: string | null;
}

/** Endpoints whose result is driven by commits or repository metadata. */
const PUSH_DRIVEN_ENDPOINTS: ReadonlySet<EndpointId> = new Set([
  ...STATS_ENDPOINTS,
  "community",
  "forks",
  "branches",
  "dependencies",
]);

/**
 * Decide whether an incremental run needs this repository/endpoint pair.
 *
 * Actions and pulse have their own time cutoffs, while traffic is a rolling
 * 14-day snapshot which must be sampled every run. The remaining endpoints do
 * not expose a `since` parameter, so the repository timestamps from the cheap
 * inventory request are used to avoid downloading unchanged payloads.
 */
export function shouldFetchIncrementally(
  endpoint: EndpointId,
  state: IncrementalState | undefined,
  repo: Pick<GhRepo, "pushed_at" | "updated_at">,
): boolean {
  if (endpoint === "line_ownership") return true;
  if (!state) return true;
  if (state.status === "pending" || state.status === "error") return true;
  // A changed token or permission scope needs the deliberately explicit full sync.
  if (state.status === "forbidden") return false;
  if (endpoint === "traffic" || endpoint === "actions" || endpoint === "pulse") return true;

  const checkpoint = state.lastOkAt ?? state.lastAttemptAt;
  if (!checkpoint) return true;
  if (!PUSH_DRIVEN_ENDPOINTS.has(endpoint)) return true;

  const changedAt = endpoint === "community" || endpoint === "forks"
    ? repo.updated_at
    : repo.pushed_at ?? repo.updated_at;
  const changed = Date.parse(changedAt);
  const checked = Date.parse(checkpoint);
  // Unknown timestamps must fail open: an extra request is safer than stale data.
  // Apply the same overlap used by time-filtered endpoints to close the small
  // fetch-to-checkpoint race. At worst this repeats one payload on the next run.
  return !Number.isFinite(changed) || !Number.isFinite(checked) || changed > checked - 10 * 60_000;
}

/** Build an inclusive checkpoint, falling back to the initial history window. */
export function incrementalSince(
  checkpoint: string | null | undefined,
  historyDays: number,
  now = Date.now(),
): string {
  const parsed = checkpoint ? Date.parse(checkpoint) : Number.NaN;
  const fallback = now - historyDays * 86_400_000;
  // Ten minutes is enough to cover pagination/write races without materially
  // increasing repeat traffic. Stable-id upserts make the overlap idempotent.
  return new Date(Number.isFinite(parsed) ? parsed - 10 * 60_000 : fallback).toISOString();
}

export interface SyncOptions {
  db: Database;
  token: string;
  /** Every organisation to inventory; targets are drawn from all of them. */
  orgs: string[];
  endpoints?: EndpointId[];
  /** Restrict to these repo ids; defaults to every non-archived repo. */
  repoIds?: number[];
  includeArchived?: boolean;
  /** Skip repos with no pushes since this ISO date. */
  activeSince?: string | null;
  /** How far back to pull PR/issue/Actions data. */
  historyDays?: number;
  /** Defaults to an incremental refresh; `full` must be requested explicitly. */
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

export interface FairPollState<T> {
  item: T;
  attempts: number;
}

interface FairPollOptions<T> {
  limit: number;
  deadline: number;
  poll: (item: T, attempt: number) => Promise<boolean>;
  retryDelay?: (attempt: number) => number;
  signal?: AbortSignal;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Poll every outstanding item once per round.
 *
 * A retrying item never owns a worker while it sleeps. This avoids the previous
 * head-of-line blocking where the first six slow statistics endpoints could hold
 * every collection slot for their full poll budget while later results sat ready.
 * Returns the items that were still pending when the deadline or cancellation hit.
 */
export async function pollInRounds<T>(
  items: readonly T[],
  options: FairPollOptions<T>,
): Promise<Array<FairPollState<T>>> {
  let pending = items.map((item) => ({ item, attempts: 0 }));

  while (pending.length > 0 && !options.signal?.aborted) {
    const outcomes = await pool(pending, Math.max(1, options.limit), async (state) => {
      state.attempts++;
      return options.poll(state.item, state.attempts);
    });
    pending = pending.filter((_, index) => !outcomes[index]);
    if (pending.length === 0 || options.signal?.aborted) break;

    const attempt = Math.max(...pending.map((state) => state.attempts));
    const delayMs = (options.retryDelay ?? statsRetryDelay)(attempt);
    if (Date.now() + delayMs > options.deadline) break;
    try {
      await wait(delayMs, options.signal);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") throw err;
      break;
    }
  }

  return pending;
}

interface RepoTarget {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  hasCommits: boolean;
  canPush: boolean;
}

/**
 * List one organisation's repositories and store them under it. Also run on its
 * own when an organisation is added, so its repositories can be chosen before
 * the first sync — a sync only fetches repositories that are already selected.
 */
export async function inventoryOrg(
  db: Database,
  client: GitHubClient,
  org: string,
  signal?: AbortSignal,
): Promise<GhRepo[]> {
  const listed = await api.listOrgRepos(client, org, signal);
  await write.writeRepos(db, org, listed);
  return listed;
}

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const started = Date.now();
  const {
    db,
    token,
    orgs,
    endpoints = ALL_ENDPOINTS,
    includeArchived = false,
    activeSince = null,
    historyDays = 365,
    mode = "incremental",
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

  // Each organisation is listed and stored separately so its rows carry the right
  // owner. One failed listing stops the run, as a single organisation always did:
  // carrying on would quietly sync a partial inventory.
  const repos: Array<GhRepo & { owner: string }> = [];
  for (const org of orgs) {
    let listed: GhRepo[];
    try {
      listed = await inventoryOrg(db, client, org, signal);
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
      if (orgs.length === 1) throw err;
      throw new Error(`Could not list repositories for ${org}: ${(err as Error)?.message ?? String(err)}`);
    }
    for (const r of listed) repos.push({ ...r, owner: org });
  }

  const targets: RepoTarget[] = repos
    .filter((r) => (includeArchived ? true : !r.archived))
    .filter((r) => !r.disabled)
    .filter((r) => (options.repoIds ? options.repoIds.includes(r.id) : true))
    .filter((r) => (activeSince ? (r.pushed_at ?? "") >= activeSince : true))
    .map((r) => ({
      id: r.id,
      owner: r.owner,
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
     consulted and finished work is skipped. Incremental mode also reads each
     pair's checkpoint so it can fetch only changes. Full mode ignores it. */

  type SyncStateRow = {
    repo_id: number;
    endpoint: string;
    status: SyncStatus;
    last_ok_at: string | null;
    last_attempt_at: string | null;
  };
  const stateByPair = new Map<string, IncrementalState>();
  if (mode !== "full") {
    const rows = await db.select<SyncStateRow[]>(
      "SELECT repo_id, endpoint, status, last_ok_at, last_attempt_at FROM sync_state",
    );
    for (const row of rows) {
      stateByPair.set(`${row.repo_id}:${row.endpoint}`, {
        status: row.status,
        lastOkAt: row.last_ok_at,
        lastAttemptAt: row.last_attempt_at,
      });
    }
  }

  const repoById = new Map(repos.map((repo) => [repo.id, repo]));
  const stateFor = (repoId: number, endpoint: EndpointId) =>
    stateByPair.get(`${repoId}:${endpoint}`);

  /** Whether this pair needs an API request in the selected mode. */
  const needsFetch = (repo: RepoTarget, endpoint: EndpointId) => {
    const state = stateFor(repo.id, endpoint);
    if (mode === "full") return true;
    if (mode === "resume") return !shouldSkip(state?.status, mode);
    const source = repoById.get(repo.id);
    return source ? shouldFetchIncrementally(endpoint, state, source) : true;
  };

  /**
   * Per-endpoint high-water mark with a small overlap. The overlap closes the
   * race between GitHub serving a page and us recording its completion; the
   * affected writers upsert by stable GitHub ids, so duplicates are harmless.
   */
  const sinceFor = (repoId: number, endpoint: EndpointId, dateOnly = false) => {
    const state = stateFor(repoId, endpoint);
    const checkpoint = mode === "incremental"
      ? state?.lastOkAt
      : null;
    const since = incrementalSince(checkpoint, historyDays);
    return dateOnly ? since.slice(0, 10) : since;
  };

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
      if (!needsFetch(repo, endpoint)) {
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

  /* ── 3. Build the independent work queues ────────────────────────────────
     Once every statistics job has been warmed, collection, ordinary REST
     endpoints and Pulse can all advance independently. They still share the
     GitHubClient's six-request semaphore, so this fills stats backoff gaps
     without increasing actual request concurrency. */

  const pendingKeys = warmKeys.filter(({ repo, endpoint }) => !settled.has(keyOf(repo, endpoint)));
  const extras = endpoints.filter((e) =>
    (["traffic", "community", "forks", "branches", "dependencies", "actions"] as EndpointId[]).includes(e),
  );
  const extraKeys: Array<{ repo: RepoTarget; endpoint: EndpointId }> = [];
  for (const repo of targets) {
    for (const endpoint of extras) {
      if (needsFetch(repo, endpoint)) extraKeys.push({ repo, endpoint });
      else skipped++;
    }
  }

  const pulseTargets = endpoints.includes("pulse")
    ? targets.filter((repo) => {
        if (needsFetch(repo, "pulse")) return true;
        skipped++;
        return false;
      })
    : [];

  const ownershipTargets = endpoints.includes("line_ownership")
    ? targets.filter((repo) => {
        if (needsFetch(repo, "line_ownership")) return true;
        skipped++;
        return false;
      })
    : [];

  phase = "syncing";
  label = "Syncing statistics and repository data";
  total = pendingKeys.length + extraKeys.length + pulseTargets.length + ownershipTargets.length;
  done = 0;
  current = null;
  emit();

  const markDone = (fullName: string) => {
    done++;
    current = fullName;
    emit();
  };

  /* ── 4. Fair statistics collection ───────────────────────────────────────
     Each round checks every pending endpoint once. Backoff happens between
     rounds, outside the request pool, so six pathological repositories cannot
     prevent later ready results from being collected. */

  const statsTask = (async () => {
    if (!pendingKeys.length || cancelled()) return;
    const unfinished = await pollInRounds(pendingKeys, {
      limit: 6,
      deadline: Date.now() + client.getStatsPollBudgetMs(),
      signal,
      poll: async ({ repo, endpoint }) => {
        if (cancelled()) return false;
        try {
          const result = await client.statsAttempt<unknown>(statsPath(repo, endpoint), {
            signal,
            allowNotFound: true,
            allowForbidden: true,
            treatEmptyAsPending: repo.hasCommits && EMPTY_STATS_ARE_PENDING.has(endpoint),
          });
          if (result.pending) return false;
          if (result.data == null) {
            await recordSync(db, repo.id, endpoint, "empty");
          } else {
            const wrote = await persistStats(db, repo, endpoint, result.data);
            if (!wrote) return false;
            await recordSync(db, repo.id, endpoint, "ok");
          }
        } catch (err) {
          if (cancelled()) return false;
          noteError(repo.fullName, endpoint, err);
          await recordSync(db, repo.id, endpoint, "error", { error: (err as Error)?.message });
        }
        markDone(repo.fullName);
        return true;
      },
    });

    if (cancelled()) return;
    await pool(unfinished, 6, async ({ item: { repo, endpoint }, attempts }) => {
      const err = new StatsPendingError(statsPath(repo, endpoint), attempts);
      noteError(repo.fullName, endpoint, err);
      await recordSync(db, repo.id, endpoint, "pending", { error: err.message });
      markDone(repo.fullName);
    });
  })();

  /* ── 5. Plain REST endpoints ──────────────────────────────────────────────
     Jobs are flattened by (repository, endpoint), instead of six repository
     workers each walking their endpoints serially. Twelve logical jobs are
     enough to cover pagination/retry waits; the client still permits only six
     simultaneous HTTP requests. */

  const extrasTask = pool(extraKeys, 12, async ({ repo, endpoint }) => {
    if (cancelled()) return;
    attempted++;
    try {
      await syncExtra(client, db, repo, endpoint, sinceFor(repo.id, endpoint, true), signal);
      await recordSync(db, repo.id, endpoint, "ok");
    } catch (err) {
      if (!cancelled()) {
        noteError(repo.fullName, endpoint, err);
        await recordSync(db, repo.id, endpoint, "error", { error: (err as Error)?.message });
      }
    } finally {
      if (!cancelled()) markDone(repo.fullName);
    }
  });

  /* ── 5b. Org-level Dependabot alerts ───────────────────────────────────── */

  const dependabotTask = pool(orgs, orgs.length, async (org) => {
    if (!endpoints.includes("dependencies") || cancelled()) return;
    // Each organisation's payload restates only its own repositories, so another
    // organisation's alerts are never cleared by this one's response.
    const orgTargets = targets.filter((repo) => repo.owner === org).map((repo) => repo.id);
    if (!orgTargets.length) return;
    try {
      const alerts = await api.dependabotAlerts(client, org, signal);
      // null means the token cannot read them; leave whatever we already have.
      if (alerts) await write.writeDependabotAlerts(db, alerts, orgTargets);
    } catch (err) {
      if (!cancelled()) noteError(org, "dependencies", err);
    }
  });

  /* ── 6. Pulse (PRs and issues, via GraphQL) ────────────────────────────── */

  const pulseTask = (async () => {
    if (!pulseTargets.length || cancelled()) return;

    // Pulse is recorded per repository, which is also the granularity at which
    // it can be resumed after a cancellation or failure.
    const failedRepos = new Set<string>();
    const idByFullName = new Map(pulseTargets.map((repo) => [repo.fullName, repo.id]));

    await syncPulse({
      client,
      db,
      repos: pulseTargets.map((repo) => ({
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
      })),
      sinceIso: new Date(Date.now() - historyDays * 86_400_000).toISOString(),
      sinceIsoByRepo: new Map(pulseTargets.map((repo) => [repo.id, sinceFor(repo.id, "pulse")])),
      signal,
      onRepoDone: async (fullName) => {
        attempted++;
        const repoId = idByFullName.get(fullName);
        if (repoId != null && !cancelled()) {
          // The next incremental run depends on this checkpoint, so do not return
          // before it is durable.
          await recordSync(db, repoId, "pulse", failedRepos.has(fullName) ? "error" : "ok");
          markDone(fullName);
        }
      },
      onError: (fullName, message) => {
        failedRepos.add(fullName);
        errors.push({ repo: fullName, endpoint: "pulse", message, kind: "error" });
      },
    });
  })();

  // Rust admits two calculations at once and divides its blame workers between
  // them, so total Git processes stay bounded. A third job downloads and prepares
  // while both calculate. API work continues independently and every completed
  // repository is durable.
  const ownershipTask = pool(ownershipTargets, 3, async (repo) => {
    if (cancelled()) return;
    attempted++;
    try {
      await recordSync(db, repo.id, "line_ownership", "pending", { error: "Ownership sync interrupted; resume to finish" });
      await syncOwnershipRepo({
        db, repoId: repo.id, fullName: repo.fullName, token, full: mode === "full", client, signal,
        onProgress: (progress) => {
          current = `${repo.fullName} · ${progress.phase}${progress.total ? ` (${progress.completed}/${progress.total} files)` : ""}`;
          emit();
        },
      });
      await recordSync(db, repo.id, "line_ownership", "ok");
    } catch (err) {
      if (!cancelled()) {
        const message = (err as Error)?.message ?? String(err);
        noteError(repo.fullName, "line_ownership", err);
        await recordSync(db, repo.id, "line_ownership", "error", { error: message });
      }
    } finally {
      if (!cancelled()) markDone(repo.fullName);
    }
  });

  await Promise.all([statsTask, extrasTask, dependabotTask, pulseTask, ownershipTask]);

  await setMeta(db, "last_sync_at", new Date().toISOString());
  await setMeta(db, "last_sync_org", orgs.join(","));

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
