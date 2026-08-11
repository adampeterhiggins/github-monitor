import type { GitHubClient } from "./client";
import type {
  GhBranch,
  GhCodeFrequency,
  GhCommitActivity,
  GhCommunityProfile,
  GhContributorStats,
  GhDependabotAlert,
  GhFork,
  GhParticipation,
  GhPunchCard,
  GhRepo,
  GhSbomResponse,
  GhTrafficClones,
  GhTrafficPath,
  GhTrafficReferrer,
  GhTrafficViews,
  GhWorkflow,
  GhWorkflowRun,
} from "./types";

export interface RepoRef {
  owner: string;
  name: string;
}

const enc = (s: string) => encodeURIComponent(s);
const base = (r: RepoRef) => `repos/${enc(r.owner)}/${enc(r.name)}`;

export async function listOrgRepos(
  client: GitHubClient,
  org: string,
  signal?: AbortSignal,
): Promise<GhRepo[]> {
  return client.paginate<GhRepo>(`orgs/${enc(org)}/repos?per_page=100&type=all`, { signal });
}

export async function listUserRepos(
  client: GitHubClient,
  signal?: AbortSignal,
): Promise<GhRepo[]> {
  return client.paginate<GhRepo>("user/repos?per_page=100&affiliation=owner,organization_member", {
    signal,
  });
}

export async function listOrgs(
  client: GitHubClient,
  signal?: AbortSignal,
): Promise<Array<{ login: string; avatar_url: string }>> {
  return client.paginate<{ login: string; avatar_url: string }>("user/orgs?per_page=100", { signal });
}

/**
 * How many commits `login` authored in a repository — in a single request.
 *
 * Asking for `per_page=1` makes the Link rel="last" page number equal the total
 * commit count, so no commits are actually downloaded. This is what lets
 * "repositories I've committed in" work *before* any sync: the `stats/*` cache is
 * empty at that point, and GraphQL's `contributionsCollection` is no use either
 * because it withholds private-repository contributions (it reports them only as
 * an opaque `restrictedContributionsCount`).
 *
 * Returns 0 when the person has no commits, and null when the repository cannot
 * be read (empty repo, no access), so callers can tell "none" from "unknown".
 */
export async function commitCountByAuthor(
  client: GitHubClient,
  repo: RepoRef,
  login: string,
  opts: { signal?: AbortSignal; since?: string } = {},
): Promise<number | null> {
  const params = new URLSearchParams({ author: login, per_page: "1" });
  if (opts.since) params.set("since", opts.since);

  const res = await client.request<unknown[]>(`${base(repo)}/commits?${params.toString()}`, {
    signal: opts.signal,
    allowNotFound: true,
    allowForbidden: true,
  });

  // 404 on an empty repository, 403 without access, 409 for an unborn default branch.
  if (res.status === 404 || res.status === 403 || res.status === 409) return null;
  if (res.lastPage != null) return res.lastPage;
  // No rel="last" means a single page: 0 or 1 commits.
  return Array.isArray(res.data) ? res.data.length : 0;
}

/* ── stats/* — all subject to the 202 cold-cache dance ─────────────────────── */

export function contributorStats(
  client: GitHubClient,
  repo: RepoRef,
  opts: { signal?: AbortSignal; hasCommits?: boolean } = {},
): Promise<GhContributorStats[] | null> {
  return client.stats<GhContributorStats[]>(`${base(repo)}/stats/contributors`, {
    signal: opts.signal,
    allowNotFound: true,
    allowForbidden: true,
    treatEmptyAsPending: opts.hasCommits === true,
  });
}

export function commitActivity(
  client: GitHubClient,
  repo: RepoRef,
  opts: { signal?: AbortSignal; hasCommits?: boolean } = {},
): Promise<GhCommitActivity[] | null> {
  return client.stats<GhCommitActivity[]>(`${base(repo)}/stats/commit_activity`, {
    signal: opts.signal,
    allowNotFound: true,
    allowForbidden: true,
    treatEmptyAsPending: opts.hasCommits === true,
  });
}

export function participation(
  client: GitHubClient,
  repo: RepoRef,
  opts: { signal?: AbortSignal } = {},
): Promise<GhParticipation | null> {
  return client.stats<GhParticipation>(`${base(repo)}/stats/participation`, {
    signal: opts.signal,
    allowNotFound: true,
    allowForbidden: true,
  });
}

export function codeFrequency(
  client: GitHubClient,
  repo: RepoRef,
  opts: { signal?: AbortSignal; hasCommits?: boolean } = {},
): Promise<GhCodeFrequency[] | null> {
  return client.stats<GhCodeFrequency[]>(`${base(repo)}/stats/code_frequency`, {
    signal: opts.signal,
    allowNotFound: true,
    allowForbidden: true,
    treatEmptyAsPending: opts.hasCommits === true,
  });
}

export function punchCard(
  client: GitHubClient,
  repo: RepoRef,
  opts: { signal?: AbortSignal } = {},
): Promise<GhPunchCard[] | null> {
  return client.stats<GhPunchCard[]>(`${base(repo)}/stats/punch_card`, {
    signal: opts.signal,
    allowNotFound: true,
    allowForbidden: true,
  });
}

/* ── traffic — needs push access, and GitHub keeps only 14 days ────────────── */

export async function trafficViews(
  client: GitHubClient,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<GhTrafficViews | null> {
  const res = await client.request<GhTrafficViews>(`${base(repo)}/traffic/views`, {
    signal,
    allowForbidden: true,
    allowNotFound: true,
  });
  return res.data;
}

export async function trafficClones(
  client: GitHubClient,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<GhTrafficClones | null> {
  const res = await client.request<GhTrafficClones>(`${base(repo)}/traffic/clones`, {
    signal,
    allowForbidden: true,
    allowNotFound: true,
  });
  return res.data;
}

export async function trafficPaths(
  client: GitHubClient,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<GhTrafficPath[] | null> {
  const res = await client.request<GhTrafficPath[]>(`${base(repo)}/traffic/popular/paths`, {
    signal,
    allowForbidden: true,
    allowNotFound: true,
  });
  return res.data;
}

export async function trafficReferrers(
  client: GitHubClient,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<GhTrafficReferrer[] | null> {
  const res = await client.request<GhTrafficReferrer[]>(`${base(repo)}/traffic/popular/referrers`, {
    signal,
    allowForbidden: true,
    allowNotFound: true,
  });
  return res.data;
}

/* ── community, forks, network ─────────────────────────────────────────────── */

export async function communityProfile(
  client: GitHubClient,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<GhCommunityProfile | null> {
  const res = await client.request<GhCommunityProfile>(`${base(repo)}/community/profile`, {
    signal,
    allowForbidden: true,
    allowNotFound: true,
  });
  return res.data;
}

export function listForks(
  client: GitHubClient,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<GhFork[]> {
  return client.paginate<GhFork>(`${base(repo)}/forks?per_page=100&sort=newest`, { signal });
}

export function listBranches(
  client: GitHubClient,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<GhBranch[]> {
  return client.paginate<GhBranch>(`${base(repo)}/branches?per_page=100`, { signal });
}

/* ── dependency graph ──────────────────────────────────────────────────────── */

export async function sbom(
  client: GitHubClient,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<GhSbomResponse | null> {
  const res = await client.request<GhSbomResponse>(`${base(repo)}/dependency-graph/sbom`, {
    signal,
    allowForbidden: true,
    allowNotFound: true,
  });
  return res.data;
}

export async function dependabotAlerts(
  client: GitHubClient,
  org: string,
  signal?: AbortSignal,
): Promise<GhDependabotAlert[]> {
  try {
    return await client.paginate<GhDependabotAlert>(
      `orgs/${enc(org)}/dependabot/alerts?per_page=100&state=open`,
      { signal, allowForbidden: true, allowNotFound: true },
    );
  } catch {
    // Needs security-events scope plus org-level Dependabot enabled.
    return [];
  }
}

/* ── actions ───────────────────────────────────────────────────────────────── */

export function listWorkflows(
  client: GitHubClient,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<GhWorkflow[]> {
  return client
    .request<{ workflows: GhWorkflow[] }>(`${base(repo)}/actions/workflows?per_page=100`, {
      signal,
      allowForbidden: true,
      allowNotFound: true,
    })
    .then((r) => r.data?.workflows ?? []);
}

/**
 * Workflow runs created on/after `since`. The runs endpoint paginates by 100 and
 * an active org can produce thousands per week, so callers cap the page count.
 */
export async function listWorkflowRuns(
  client: GitHubClient,
  repo: RepoRef,
  since: string,
  opts: { signal?: AbortSignal; maxPages?: number } = {},
): Promise<GhWorkflowRun[]> {
  const maxPages = opts.maxPages ?? 5;
  const out: GhWorkflowRun[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await client.request<{ total_count: number; workflow_runs: GhWorkflowRun[] }>(
      `${base(repo)}/actions/runs?per_page=100&page=${page}&created=>=${since}`,
      { signal: opts.signal, allowForbidden: true, allowNotFound: true },
    );
    const runs = res.data?.workflow_runs ?? [];
    out.push(...runs);
    if (runs.length < 100) break;
  }
  return out;
}
