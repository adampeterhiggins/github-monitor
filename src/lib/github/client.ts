import { fetch } from "@tauri-apps/plugin-http";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/**
 * A `stats/*` endpoint that never finished computing inside the poll budget.
 * Not fatal: GitHub keeps computing server-side, so the next sweep usually
 * finds a warm cache. Callers record it and move on.
 */
export class StatsPendingError extends Error {
  constructor(
    readonly path: string,
    readonly attempts: number,
  ) {
    super(`GitHub is still computing ${path} after ${attempts} attempts`);
    this.name = "StatsPendingError";
  }
}

export interface RateLimitState {
  limit: number;
  remaining: number;
  /** Epoch seconds. */
  reset: number;
  resource: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Sent as If-None-Match; a 304 comes back as `notModified`. */
  etag?: string | null;
  /** Accept header override, e.g. the SBOM or diff media types. */
  accept?: string;
  method?: "GET" | "POST";
  body?: unknown;
  /** Treat 404 as an empty result instead of throwing. */
  allowNotFound?: boolean;
  /** Treat 403 as an empty result — used for push-access-only endpoints. */
  allowForbidden?: boolean;
}

export interface GhResponse<T> {
  status: number;
  data: T | null;
  etag: string | null;
  notModified: boolean;
  /** Present on paginated responses. */
  nextUrl: string | null;
  /**
   * `page` of the Link rel="last" URL, when present.
   *
   * With `per_page=1` this is the total item count, which turns an unbounded
   * count into a single request — used to count a person's commits in a
   * repository without downloading them.
   */
  lastPage: number | null;
}

export interface StatsAttempt<T> {
  /** True when GitHub is still computing this statistics payload. */
  pending: boolean;
  /** The completed payload, or null for a definitively empty/inaccessible result. */
  data: T | null;
}

export interface ClientEvents {
  onRateLimit?: (state: RateLimitState) => void;
  /** Fired while parked on a rate limit or secondary limit, so the UI can explain the pause. */
  onThrottle?: (info: { reason: string; waitMs: number; path: string }) => void;
  onStatsPending?: (info: { path: string; attempt: number; waitMs: number }) => void;
}

/**
 * Read a body that is only used for diagnostics. A failure here must not replace
 * the status code we are actually reporting on.
 */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Bounded concurrency. GitHub tolerates a handful of parallel requests; more invites secondary limits. */
class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve));
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}

export interface GitHubClientConfig {
  token: string;
  concurrency?: number;
  /** Total wall-clock budget for polling one stats endpoint. */
  statsPollBudgetMs?: number;
  /** Stop making requests when the core budget drops below this. */
  rateLimitFloor?: number;
  events?: ClientEvents;
}

export const DEFAULT_STATS_POLL_BUDGET_MS = 420_000;

const STATS_BACKOFF_MS = [1_000, 2_000, 3_000, 5_000, 8_000, 10_000, 15_000, 20_000, 30_000];

export function statsRetryDelay(attempt: number): number {
  return STATS_BACKOFF_MS[Math.min(Math.max(0, attempt - 1), STATS_BACKOFF_MS.length - 1)];
}

export class GitHubClient {
  private readonly token: string;
  private readonly sem: Semaphore;
  private readonly statsPollBudgetMs: number;
  private readonly rateLimitFloor: number;
  private readonly events: ClientEvents;
  private rateLimit: RateLimitState | null = null;
  private readonly rateLimits = new Map<string, RateLimitState>();
  /** Secondary limits are shared across REST and GraphQL. */
  private secondaryThrottleUntil = 0;
  /** Primary REST and GraphQL budgets reset independently. */
  private readonly primaryThrottleUntil = new Map<string, number>();

  constructor(config: GitHubClientConfig) {
    this.token = config.token;
    this.sem = new Semaphore(config.concurrency ?? 6);
    // Measured against a large real repository (focaldata/orchestra, 33
    // contributors over 69+ weeks) which took over six minutes to compute from
    // cold. Repos that still miss the budget are recorded as `pending` and retried
    // on the next sync; the sync's fair polling rounds keep them from stalling others.
    this.statsPollBudgetMs = config.statsPollBudgetMs ?? DEFAULT_STATS_POLL_BUDGET_MS;
    this.rateLimitFloor = config.rateLimitFloor ?? 50;
    this.events = config.events ?? {};
  }

  getRateLimit(): RateLimitState | null {
    return this.rateLimit;
  }

  getStatsPollBudgetMs(): number {
    return this.statsPollBudgetMs;
  }

  private headers(options: RequestOptions): Record<string, string> {
    const h: Record<string, string> = {
      Accept: options.accept ?? "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "github-monitor",
    };
    if (options.etag) h["If-None-Match"] = options.etag;
    return h;
  }

  private absoluteUrl(path: string): string {
    return path.startsWith("http") ? path : `${API_ROOT}/${path.replace(/^\//, "")}`;
  }

  private recordRateLimit(headers: Headers): void {
    const limit = headers.get("x-ratelimit-limit");
    const remaining = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");
    if (limit && remaining && reset) {
      this.rateLimit = {
        limit: Number(limit),
        remaining: Number(remaining),
        reset: Number(reset),
        resource: headers.get("x-ratelimit-resource") ?? "core",
      };
      this.rateLimits.set(this.rateLimit.resource, this.rateLimit);
      this.events.onRateLimit?.(this.rateLimit);
    }
  }

  private resourceFor(path: string): string {
    return path.replace(/^https:\/\/api\.github\.com\//, "").startsWith("graphql")
      ? "graphql"
      : "core";
  }

  /** Park callers on shared secondary limits or their own resource's primary limit. */
  private async respectBudget(path: string, signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const resource = this.resourceFor(path);
    const throttleUntil = Math.max(
      this.secondaryThrottleUntil,
      this.primaryThrottleUntil.get(resource) ?? 0,
    );
    if (throttleUntil > now) {
      const waitMs = throttleUntil - now;
      this.events.onThrottle?.({ reason: "rate limit", waitMs, path });
      await sleep(waitMs, signal);
      return;
    }
    const rl = this.rateLimits.get(resource);
    if (rl && rl.remaining <= this.rateLimitFloor) {
      const waitMs = Math.max(0, rl.reset * 1000 - now) + 1_000;
      this.primaryThrottleUntil.set(resource, now + waitMs);
      this.events.onThrottle?.({ reason: "rate limit exhausted", waitMs, path });
      await sleep(waitMs, signal);
    }
  }

  private static parseNext(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    for (const part of linkHeader.split(",")) {
      const m = part.match(/<([^>]+)>;\s*rel="next"/);
      if (m) return m[1];
    }
    return null;
  }

  private static parseLastPage(linkHeader: string | null): number | null {
    if (!linkHeader) return null;
    for (const part of linkHeader.split(",")) {
      const m = part.match(/<([^>]+)>;\s*rel="last"/);
      if (m) {
        const page = new URL(m[1]).searchParams.get("page");
        const n = page ? Number(page) : NaN;
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  }

  /**
   * One HTTP round trip with retries for transient failures, primary rate limits
   * and secondary (abuse) limits. Does NOT interpret 202 — see `stats`.
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<GhResponse<T>> {
    const url = this.absoluteUrl(path);
    const maxAttempts = 5;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.respectBudget(path, options.signal);
      const release = await this.sem.acquire();
      let res: Response;
      try {
        res = await fetch(url, {
          method: options.method ?? "GET",
          headers: this.headers(options),
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: options.signal,
        });
      } catch (err) {
        release();
        if ((err as Error)?.name === "AbortError") throw err;
        lastError = err;
        if (attempt === maxAttempts) break;
        await sleep(2 ** attempt * 500, options.signal);
        continue;
      }

      try {
        this.recordRateLimit(res.headers);
        const etag = res.headers.get("etag");
        const linkHeader = res.headers.get("link");
        const nextUrl = GitHubClient.parseNext(linkHeader);
        const lastPage = GitHubClient.parseLastPage(linkHeader);

        if (res.status === 304) {
          return { status: 304, data: null, etag: options.etag ?? null, notModified: true, nextUrl, lastPage };
        }

        // Secondary/abuse limits and exhausted primary budget both surface as 403/429.
        if (res.status === 403 || res.status === 429) {
          const retryAfter = res.headers.get("retry-after");
          const remaining = res.headers.get("x-ratelimit-remaining");
          const isPrimary = remaining === "0";
          const bodyText = await safeText(res);

          // A 403 that is not a limit is a genuine permission problem.
          if (!retryAfter && !isPrimary) {
            if (options.allowForbidden) {
              return { status: 403, data: null, etag: null, notModified: false, nextUrl: null, lastPage: null };
            }
            throw new GitHubError(
              `403 Forbidden on ${path}. The token likely lacks the required access.`,
              403,
              path,
              bodyText,
            );
          }

          if (attempt === maxAttempts) {
            throw new GitHubError(`Rate limited on ${path}`, res.status, path, bodyText);
          }
          const waitMs = retryAfter
            ? Number(retryAfter) * 1000
            : Math.max(0, (this.rateLimit?.reset ?? 0) * 1000 - Date.now()) + 1_000;
          const capped = Math.min(waitMs || 60_000, 15 * 60_000);
          if (isPrimary) {
            const resource = res.headers.get("x-ratelimit-resource") ?? this.resourceFor(path);
            this.primaryThrottleUntil.set(resource, Date.now() + capped);
          } else {
            this.secondaryThrottleUntil = Date.now() + capped;
          }
          this.events.onThrottle?.({
            reason: isPrimary ? "rate limit exhausted" : "secondary rate limit",
            waitMs: capped,
            path,
          });
          release();
          await sleep(capped, options.signal);
          continue;
        }

        if (res.status === 404 && options.allowNotFound) {
          return { status: 404, data: null, etag: null, notModified: false, nextUrl: null, lastPage: null };
        }

        // 204 means "definitively nothing", distinct from 202 "not computed yet".
        if (res.status === 204) {
          return { status: 204, data: null, etag, notModified: false, nextUrl: null, lastPage };
        }

        if (res.status >= 500) {
          if (attempt === maxAttempts) {
            throw new GitHubError(`GitHub ${res.status} on ${path}`, res.status, path);
          }
          release();
          await sleep(2 ** attempt * 500, options.signal);
          continue;
        }

        if (!res.ok && res.status !== 202) {
          const bodyText = await safeText(res);
          throw new GitHubError(`GitHub ${res.status} on ${path}`, res.status, path, bodyText);
        }

        // 202 carries an empty or `{}` body; hand the status back for `stats` to poll on.
        let text: string;
        try {
          text = await res.text();
        } catch (err) {
          // The request succeeded and only the body stream failed — reqwest reports
          // this as "error decoding response body". It is transient, and was being
          // surfaced as a permanent sync failure because the retry loop above only
          // covered the fetch itself. Larger payloads (workflow runs, branches) hit
          // it most often.
          if ((err as Error)?.name === "AbortError") throw err;
          lastError = err;
          if (attempt === maxAttempts) break;
          await sleep(2 ** attempt * 500, options.signal);
          continue;
        }

        let data: T | null;
        try {
          data = text ? (JSON.parse(text) as T) : null;
        } catch (err) {
          // Truncated JSON is the same transient failure wearing a different hat.
          lastError = err;
          if (attempt === maxAttempts) break;
          await sleep(2 ** attempt * 500, options.signal);
          continue;
        }

        return { status: res.status, data, etag, notModified: false, nextUrl, lastPage };
      } finally {
        release();
      }
    }

    throw new GitHubError(
      `Request to ${path} failed after ${maxAttempts} attempts: ${String(lastError)}`,
      0,
      path,
    );
  }

  /** Follow Link rel="next" to exhaustion, concatenating array pages. */
  async paginate<T>(path: string, options: RequestOptions = {}): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = this.absoluteUrl(path);
    // ETags are per-page, so conditional requests do not compose across pagination.
    const { etag: _etag, ...rest } = options;
    while (url) {
      const res: GhResponse<T[]> = await this.request<T[]>(url, rest);
      if (Array.isArray(res.data)) out.push(...res.data);
      url = res.nextUrl;
    }
    return out;
  }

  /**
   * Fetch a `repos/{owner}/{repo}/stats/*` endpoint.
   *
   * GitHub computes these lazily: the first request for a cold repo returns
   * **202 with an empty body** and kicks off a background job, and only later
   * requests return 200 with real data. This was confirmed against the target
   * org — of eight repos probed cold, seven returned 202 and filled in on retry.
   * So a single request is never enough; we poll with backoff inside a budget.
   *
   * @param treatEmptyAsPending When the repo is known to have commits, a 200 with
   *   an empty array also means "still warming" rather than "no contributors".
   */
  async stats<T>(
    path: string,
    options: RequestOptions & { treatEmptyAsPending?: boolean } = {},
  ): Promise<T | null> {
    const deadline = Date.now() + this.statsPollBudgetMs;
    let attempt = 0;

    for (;;) {
      attempt++;
      const result = await this.statsAttempt<T>(path, options);
      if (!result.pending) return result.data;

      const waitMs = statsRetryDelay(attempt);
      if (Date.now() + waitMs > deadline) {
        throw new StatsPendingError(path, attempt);
      }
      this.events.onStatsPending?.({ path, attempt, waitMs });
      await sleep(waitMs, options.signal);
    }
  }

  /**
   * Poll a computed statistics endpoint exactly once.
   *
   * Keeping this separate from `stats` lets the sync scheduler release its job
   * slot during backoff and check every repository fairly. Callers that want the
   * original self-contained polling behaviour can continue to use `stats`.
   */
  async statsAttempt<T>(
    path: string,
    options: RequestOptions & { treatEmptyAsPending?: boolean } = {},
  ): Promise<StatsAttempt<T>> {
    const res = await this.request<T>(path, options);

    if (res.notModified || res.status === 204 || res.status === 404 || res.status === 403) {
      return { pending: false, data: null };
    }

    const isEmpty =
      res.data == null ||
      (Array.isArray(res.data) && res.data.length === 0) ||
      (typeof res.data === "object" && Object.keys(res.data as object).length === 0);

    return {
      pending: res.status === 202 || (isEmpty && options.treatEmptyAsPending === true),
      data: res.data,
    };
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const res = await this.request<{ data: T; errors?: Array<{ message: string; type?: string }> }>(
      "graphql",
      { ...options, method: "POST", body: { query, variables } },
    );
    const payload = res.data;
    if (!payload) throw new GitHubError("Empty GraphQL response", res.status, "graphql");
    if (payload.errors?.length) {
      // Partial data with NOT_FOUND/FORBIDDEN errors is normal across a big org.
      const fatal = payload.errors.filter(
        (e) => e.type !== "NOT_FOUND" && e.type !== "FORBIDDEN",
      );
      if (fatal.length) {
        throw new GitHubError(
          `GraphQL: ${fatal.map((e) => e.message).join("; ")}`,
          200,
          "graphql",
          payload.errors,
        );
      }
    }
    return payload.data;
  }

  /** Verify the token and read back the granted scopes. */
  async verify(): Promise<{ login: string; scopeHeader: string | null }> {
    const url = this.absoluteUrl("user");
    const res = await fetch(url, { headers: this.headers({}) });
    if (!res.ok) {
      throw new GitHubError(
        res.status === 401 ? "Token rejected by GitHub (401)." : `GitHub ${res.status}`,
        res.status,
        "user",
      );
    }
    this.recordRateLimit(res.headers);
    const body = (await res.json()) as { login: string };
    return { login: body.login, scopeHeader: res.headers.get("x-oauth-scopes") };
  }
}
