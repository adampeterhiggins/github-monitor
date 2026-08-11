import type Database from "@tauri-apps/plugin-sql";
import { bulkInsert, withWriteLock } from ".";
import { Params } from "./params";

/**
 * Read layer.
 *
 * Every query takes an explicit list of repo ids, and most also take an optional
 * list of contributor logins. That is how the two filters work: GitHub scopes
 * Insights to one repository and offers no contributor filter at all, whereas here
 * both repository and contributor are dimensions you slice by.
 *
 * `logins = null` (or empty) means "every contributor" and adds no SQL clause.
 *
 * Aggregation happens in SQL rather than JavaScript — summing ~300k weekly rows
 * per page view in the renderer would be needlessly slow.
 */

export type Logins = readonly string[] | null;

export interface RepoRow {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  private: number;
  fork: number;
  archived: number;
  default_branch: string | null;
  language: string | null;
  size_kb: number;
  stars: number;
  forks: number;
  open_issues: number;
  can_push: number;
  created_at: string | null;
  pushed_at: string | null;
  html_url: string | null;
  description: string | null;
  included: number;
}

export async function listRepos(db: Database, owner?: string): Promise<RepoRow[]> {
  const p = new Params();
  const where = owner ? `WHERE r.owner = ${p.add(owner)}` : "";
  return db.select<RepoRow[]>(
    `SELECT r.*, COALESCE(s.included, 1) AS included
     FROM repos r
     LEFT JOIN repo_selection s ON s.repo_id = r.id
     ${where}
     ORDER BY r.pushed_at DESC NULLS LAST`,
    p.values,
  );
}

/**
 * Persist the repository selection.
 *
 * Written as one multi-row upsert rather than a loop in a transaction: real
 * transactions are not available through this plugin's connection pool (see
 * ../db/index.ts), and a single statement is atomic anyway.
 */
export async function setRepoSelection(
  db: Database,
  selections: Array<{ repoId: number; included: boolean }>,
): Promise<void> {
  if (!selections.length) return;
  await withWriteLock(() =>
    bulkInsert(db, {
      table: "repo_selection",
      columns: ["repo_id", "included"],
      conflictColumns: ["repo_id"],
      rows: selections.map((s) => [s.repoId, s.included ? 1 : 0]),
    }),
  );
}

/* ── Repository / contributor inventories for the filter UIs ─────────────── */

export interface RepoActivityRow {
  repo_id: number;
  commits: number;
  /** Latest week with activity, Unix seconds. */
  last_week: number | null;
}

/**
 * Repositories a given login has commits in, from the local cache.
 *
 * Backs "repositories I've committed in". Only covers repositories that have been
 * synced — the caller surfaces that when the result is empty.
 */
export async function reposContributedTo(db: Database, login: string): Promise<RepoActivityRow[]> {
  return db.select<RepoActivityRow[]>(
    `SELECT repo_id, SUM(commits) AS commits, MAX(week) AS last_week
     FROM contributor_weeks
     WHERE LOWER(login) = LOWER($1)
     GROUP BY repo_id
     HAVING commits > 0
     ORDER BY commits DESC`,
    [login],
  );
}

export interface AuthorProbeRow {
  repo_id: number;
  commits: number;
  readable: number;
  checked_at: string | null;
}

/**
 * Cached results of probing `/commits?author=` per repository.
 *
 * Unlike `reposContributedTo`, this works from a cold cache — it is what makes
 * "repositories I've committed in" usable before any sync has run.
 */
export async function getAuthorProbe(db: Database, login: string): Promise<AuthorProbeRow[]> {
  return db.select<AuthorProbeRow[]>(
    `SELECT repo_id, commits, readable, checked_at
     FROM author_repo_probe
     WHERE LOWER(login) = LOWER($1)`,
    [login],
  );
}

export async function saveAuthorProbe(
  db: Database,
  login: string,
  results: Array<{ repoId: number; commits: number; readable: boolean }>,
): Promise<void> {
  if (!results.length) return;
  const checkedAt = new Date().toISOString();
  await withWriteLock(() =>
    bulkInsert(db, {
      table: "author_repo_probe",
      columns: ["login", "repo_id", "commits", "readable", "checked_at"],
      conflictColumns: ["login", "repo_id"],
      rows: results.map((r) => [login, r.repoId, r.commits, r.readable ? 1 : 0, checkedAt]),
    }),
  );
}

/** Total commits and latest activity per repository, for the selection list. */
export async function repoActivity(db: Database): Promise<RepoActivityRow[]> {
  return db.select<RepoActivityRow[]>(
    `SELECT repo_id, SUM(commits) AS commits, MAX(week) AS last_week
     FROM contributor_weeks
     GROUP BY repo_id`,
  );
}

export interface ContributorSummary {
  login: string;
  avatar_url: string | null;
  html_url: string | null;
  commits: number;
  additions: number;
  deletions: number;
  repos: number;
  last_week: number | null;
}

/**
 * Contributors with activity in the selected repositories, ranked by commits.
 * Drives the contributor filter's list. Deliberately not date-scoped, so someone
 * who is quiet in the current period can still be selected.
 *
 * Grouped by `LOWER(login)` rather than `login`. GitHub normally returns one
 * consistent casing per account, but the cache's primary key is case-sensitive, so
 * two casings would otherwise list the same person twice with their commits split
 * between the rows — while the filter, which compares case-insensitively, would
 * match both. Avatar and profile URL come from scalar subqueries rather than a
 * join, because a join on the same loose comparison could duplicate rows and
 * inflate the sums.
 */
export async function listContributors(
  db: Database,
  repoIds: readonly number[],
): Promise<ContributorSummary[]> {
  const p = new Params();
  const ids = p.in(repoIds);
  return db.select<ContributorSummary[]>(
    `WITH agg AS (
       SELECT LOWER(login)          AS key,
              MIN(login)            AS login,
              SUM(commits)          AS commits,
              SUM(additions)        AS additions,
              SUM(deletions)        AS deletions,
              COUNT(DISTINCT repo_id) AS repos,
              MAX(week)             AS last_week
       FROM contributor_weeks
       WHERE repo_id IN ${ids}
       GROUP BY LOWER(login)
     )
     SELECT a.login,
            (SELECT c.avatar_url FROM contributors c WHERE LOWER(c.login) = a.key LIMIT 1) AS avatar_url,
            (SELECT c.html_url   FROM contributors c WHERE LOWER(c.login) = a.key LIMIT 1) AS html_url,
            a.commits, a.additions, a.deletions, a.repos, a.last_week
     FROM agg a
     WHERE a.commits > 0
     ORDER BY a.commits DESC`,
    p.values,
  );
}

/* ── Contributors ───────────────────────────────────────────────────────── */

export interface WeekPoint {
  week: number;
  commits: number;
  additions: number;
  deletions: number;
}

/** Org-wide weekly totals across the selected repositories and contributors. */
export async function contributorWeeklyTotals(
  db: Database,
  repoIds: readonly number[],
  fromWeek: number,
  toWeek: number,
  logins: Logins = null,
): Promise<WeekPoint[]> {
  const p = new Params();
  const from = p.add(fromWeek);
  const to = p.add(toWeek);
  const ids = p.in(repoIds);
  const loginClause = p.loginFilter("login", logins);
  return db.select<WeekPoint[]>(
    `SELECT week,
            SUM(commits)   AS commits,
            SUM(additions) AS additions,
            SUM(deletions) AS deletions
     FROM contributor_weeks
     WHERE week >= ${from} AND week <= ${to} AND repo_id IN ${ids}${loginClause}
     GROUP BY week
     ORDER BY week`,
    p.values,
  );
}

export interface ContributorWeekRow extends WeekPoint {
  login: string;
}

/**
 * Per-contributor weekly rows, already summed across repositories.
 *
 * Grouped case-insensitively for the same reason as `listContributors`: otherwise
 * one person could get two cards with their commits split between them.
 */
export async function contributorWeeklyByLogin(
  db: Database,
  repoIds: readonly number[],
  fromWeek: number,
  toWeek: number,
  logins: Logins = null,
): Promise<ContributorWeekRow[]> {
  const p = new Params();
  const from = p.add(fromWeek);
  const to = p.add(toWeek);
  const ids = p.in(repoIds);
  const loginClause = p.loginFilter("login", logins);
  return db.select<ContributorWeekRow[]>(
    `SELECT MIN(login) AS login, week,
            SUM(commits)   AS commits,
            SUM(additions) AS additions,
            SUM(deletions) AS deletions
     FROM contributor_weeks
     WHERE week >= ${from} AND week <= ${to} AND repo_id IN ${ids}${loginClause}
     GROUP BY LOWER(login), week
     ORDER BY LOWER(login), week`,
    p.values,
  );
}

export interface ContributorMeta {
  login: string;
  avatar_url: string | null;
  html_url: string | null;
  type: string | null;
}

export async function listContributorMeta(db: Database): Promise<ContributorMeta[]> {
  return db.select<ContributorMeta[]>(
    "SELECT login, avatar_url, html_url, type FROM contributors",
  );
}

/** Per-repository totals for one contributor — powers the drill-down on a card. */
export async function contributorRepoBreakdown(
  db: Database,
  login: string,
  repoIds: readonly number[],
  fromWeek: number,
  toWeek: number,
): Promise<Array<{ full_name: string; commits: number; additions: number; deletions: number }>> {
  const p = new Params();
  const who = p.add(login);
  const from = p.add(fromWeek);
  const to = p.add(toWeek);
  const ids = p.in(repoIds);
  return db.select(
    `SELECT r.full_name,
            SUM(cw.commits)   AS commits,
            SUM(cw.additions) AS additions,
            SUM(cw.deletions) AS deletions
     FROM contributor_weeks cw
     JOIN repos r ON r.id = cw.repo_id
     WHERE LOWER(cw.login) = LOWER(${who})
       AND cw.week >= ${from} AND cw.week <= ${to}
       AND cw.repo_id IN ${ids}
     GROUP BY r.full_name
     HAVING commits > 0
     ORDER BY commits DESC`,
    p.values,
  );
}

/** Earliest week with any data, for resolving the "all time" period. */
export async function earliestWeek(
  db: Database,
  repoIds: readonly number[],
): Promise<number | null> {
  const p = new Params();
  const ids = p.in(repoIds);
  const rows = await db.select<Array<{ w: number | null }>>(
    `SELECT MIN(week) AS w FROM contributor_weeks WHERE repo_id IN ${ids}`,
    p.values,
  );
  return rows[0]?.w ?? null;
}

/* ── Commits / code frequency / punchcard ───────────────────────────────── */

/**
 * Day-of-week commit detail. `commit_activity` carries no contributor dimension,
 * so this cannot honour a contributor filter — pages using it say so rather than
 * silently returning unfiltered numbers.
 */
export async function commitActivityDaily(
  db: Database,
  repoIds: readonly number[],
  fromWeek: number,
  toWeek: number,
): Promise<Array<{ week: number; dow: number; commits: number }>> {
  const p = new Params();
  const from = p.add(fromWeek);
  const to = p.add(toWeek);
  const ids = p.in(repoIds);
  return db.select(
    `SELECT week, dow, SUM(commits) AS commits
     FROM commit_activity
     WHERE week >= ${from} AND week <= ${to} AND repo_id IN ${ids}
     GROUP BY week, dow
     ORDER BY week, dow`,
    p.values,
  );
}

/**
 * Weekly additions and deletions.
 *
 * Two sources, chosen by whether a contributor filter is active:
 *  - unfiltered: `code_frequency`, which is GitHub's own repo-wide series;
 *  - filtered: `contributor_weeks`, the only table with per-contributor line counts.
 *
 * The two can differ slightly, because `code_frequency` counts everything on the
 * default branch whereas `contributor_weeks` only counts work GitHub could
 * attribute to an account. Callers note which source is in use.
 */
export async function codeFrequencyWeekly(
  db: Database,
  repoIds: readonly number[],
  fromWeek: number,
  toWeek: number,
  logins: Logins = null,
): Promise<Array<{ week: number; additions: number; deletions: number }>> {
  const p = new Params();
  const from = p.add(fromWeek);
  const to = p.add(toWeek);
  const ids = p.in(repoIds);

  if (logins && logins.length > 0) {
    const loginClause = p.loginFilter("login", logins);
    return db.select(
      `SELECT week, SUM(additions) AS additions, SUM(deletions) AS deletions
       FROM contributor_weeks
       WHERE week >= ${from} AND week <= ${to} AND repo_id IN ${ids}${loginClause}
       GROUP BY week
       ORDER BY week`,
      p.values,
    );
  }

  return db.select(
    `SELECT week, SUM(additions) AS additions, SUM(deletions) AS deletions
     FROM code_frequency
     WHERE week >= ${from} AND week <= ${to} AND repo_id IN ${ids}
     GROUP BY week
     ORDER BY week`,
    p.values,
  );
}

/** Punch card totals. GitHub's payload has no contributor dimension. */
export async function punchcardTotals(
  db: Database,
  repoIds: readonly number[],
): Promise<Array<{ dow: number; hour: number; commits: number }>> {
  const p = new Params();
  const ids = p.in(repoIds);
  return db.select(
    `SELECT dow, hour, SUM(commits) AS commits
     FROM punchcard
     WHERE repo_id IN ${ids}
     GROUP BY dow, hour`,
    p.values,
  );
}

export async function commitsByRepo(
  db: Database,
  repoIds: readonly number[],
  fromWeek: number,
  toWeek: number,
  logins: Logins = null,
): Promise<
  Array<{ id: number; full_name: string; commits: number; additions: number; deletions: number }>
> {
  const p = new Params();
  const from = p.add(fromWeek);
  const to = p.add(toWeek);
  const ids = p.in(repoIds);
  const loginClause = p.loginFilter("cw.login", logins);
  return db.select(
    `SELECT r.id, r.full_name,
            SUM(cw.commits)   AS commits,
            SUM(cw.additions) AS additions,
            SUM(cw.deletions) AS deletions
     FROM contributor_weeks cw
     JOIN repos r ON r.id = cw.repo_id
     WHERE cw.week >= ${from} AND cw.week <= ${to} AND cw.repo_id IN ${ids}${loginClause}
     GROUP BY r.id, r.full_name
     ORDER BY commits DESC`,
    p.values,
  );
}

/* ── Pulse ──────────────────────────────────────────────────────────────── */

export interface PulseSummary {
  prsOpened: number;
  prsMerged: number;
  prsClosedUnmerged: number;
  issuesOpened: number;
  issuesClosed: number;
  activeAuthors: number;
  commits: number;
  reposActive: number;
}

export async function pulseSummary(
  db: Database,
  repoIds: readonly number[],
  fromIso: string,
  toIso: string,
  fromWeek: number,
  toWeek: number,
  logins: Logins = null,
): Promise<PulseSummary> {
  const p1 = new Params();
  const f1 = p1.add(fromIso);
  const t1 = p1.add(toIso);
  const ids1 = p1.in(repoIds);
  const author1 = p1.loginFilter("author", logins);

  const rows = await db.select<
    Array<{ prs_opened: number; prs_merged: number; prs_closed_unmerged: number }>
  >(
    `SELECT
       SUM(CASE WHEN created_at >= ${f1} AND created_at <= ${t1} THEN 1 ELSE 0 END) AS prs_opened,
       SUM(CASE WHEN merged_at  >= ${f1} AND merged_at  <= ${t1} THEN 1 ELSE 0 END) AS prs_merged,
       SUM(CASE WHEN closed_at  >= ${f1} AND closed_at  <= ${t1} AND merged_at IS NULL THEN 1 ELSE 0 END)
         AS prs_closed_unmerged
     FROM pull_requests
     WHERE repo_id IN ${ids1}${author1}`,
    p1.values,
  );

  const p2 = new Params();
  const f2 = p2.add(fromIso);
  const t2 = p2.add(toIso);
  const ids2 = p2.in(repoIds);
  const author2 = p2.loginFilter("author", logins);
  const issueRows = await db.select<Array<{ opened: number; closed: number }>>(
    `SELECT
       SUM(CASE WHEN created_at >= ${f2} AND created_at <= ${t2} THEN 1 ELSE 0 END) AS opened,
       SUM(CASE WHEN closed_at  >= ${f2} AND closed_at  <= ${t2} THEN 1 ELSE 0 END) AS closed
     FROM issues
     WHERE repo_id IN ${ids2}${author2}`,
    p2.values,
  );

  const p3 = new Params();
  const f3 = p3.add(fromWeek);
  const t3 = p3.add(toWeek);
  const ids3 = p3.in(repoIds);
  const login3 = p3.loginFilter("login", logins);
  const commitRows = await db.select<
    Array<{ commits: number; authors: number; repos_active: number }>
  >(
    `SELECT COALESCE(SUM(commits), 0) AS commits,
            COUNT(DISTINCT login)     AS authors,
            COUNT(DISTINCT repo_id)   AS repos_active
     FROM contributor_weeks
     WHERE week >= ${f3} AND week <= ${t3} AND repo_id IN ${ids3}${login3}`,
    p3.values,
  );

  return {
    prsOpened: rows[0]?.prs_opened ?? 0,
    prsMerged: rows[0]?.prs_merged ?? 0,
    prsClosedUnmerged: rows[0]?.prs_closed_unmerged ?? 0,
    issuesOpened: issueRows[0]?.opened ?? 0,
    issuesClosed: issueRows[0]?.closed ?? 0,
    activeAuthors: commitRows[0]?.authors ?? 0,
    commits: commitRows[0]?.commits ?? 0,
    reposActive: commitRows[0]?.repos_active ?? 0,
  };
}

export async function pulseByRepo(
  db: Database,
  repoIds: readonly number[],
  fromIso: string,
  toIso: string,
  logins: Logins = null,
): Promise<
  Array<{
    full_name: string;
    prs_opened: number;
    prs_merged: number;
    issues_opened: number;
    issues_closed: number;
  }>
> {
  const p = new Params();
  const f = p.add(fromIso);
  const t = p.add(toIso);
  const prAuthor = p.loginFilter("author", logins);
  const f2 = p.add(fromIso);
  const t2 = p.add(toIso);
  const issueAuthor = p.loginFilter("author", logins);
  const ids = p.in(repoIds);
  return db.select(
    `SELECT r.full_name,
            COALESCE(p.prs_opened, 0)    AS prs_opened,
            COALESCE(p.prs_merged, 0)    AS prs_merged,
            COALESCE(i.issues_opened, 0) AS issues_opened,
            COALESCE(i.issues_closed, 0) AS issues_closed
     FROM repos r
     LEFT JOIN (
       SELECT repo_id,
              SUM(CASE WHEN created_at >= ${f} AND created_at <= ${t} THEN 1 ELSE 0 END) AS prs_opened,
              SUM(CASE WHEN merged_at  >= ${f} AND merged_at  <= ${t} THEN 1 ELSE 0 END) AS prs_merged
       FROM pull_requests WHERE 1 = 1${prAuthor} GROUP BY repo_id
     ) p ON p.repo_id = r.id
     LEFT JOIN (
       SELECT repo_id,
              SUM(CASE WHEN created_at >= ${f2} AND created_at <= ${t2} THEN 1 ELSE 0 END) AS issues_opened,
              SUM(CASE WHEN closed_at  >= ${f2} AND closed_at  <= ${t2} THEN 1 ELSE 0 END) AS issues_closed
       FROM issues WHERE 1 = 1${issueAuthor} GROUP BY repo_id
     ) i ON i.repo_id = r.id
     WHERE r.id IN ${ids}
       AND (p.prs_opened > 0 OR p.prs_merged > 0 OR i.issues_opened > 0 OR i.issues_closed > 0)
     ORDER BY prs_merged DESC, prs_opened DESC`,
    p.values,
  );
}

/** Merged-PR authors ranked, plus review counts on their pull requests. */
export async function pulseAuthors(
  db: Database,
  repoIds: readonly number[],
  fromIso: string,
  toIso: string,
  logins: Logins = null,
): Promise<Array<{ author: string; prs_opened: number; prs_merged: number; reviews: number }>> {
  const p = new Params();
  const f = p.add(fromIso);
  const t = p.add(toIso);
  const ids = p.in(repoIds);
  const author = p.loginFilter("author", logins);
  return db.select(
    `SELECT author,
            SUM(CASE WHEN created_at >= ${f} AND created_at <= ${t} THEN 1 ELSE 0 END) AS prs_opened,
            SUM(CASE WHEN merged_at  >= ${f} AND merged_at  <= ${t} THEN 1 ELSE 0 END) AS prs_merged,
            SUM(CASE WHEN created_at >= ${f} AND created_at <= ${t} THEN reviews ELSE 0 END) AS reviews
     FROM pull_requests
     WHERE author IS NOT NULL AND repo_id IN ${ids}${author}
     GROUP BY author
     HAVING prs_opened > 0 OR prs_merged > 0
     ORDER BY prs_merged DESC, prs_opened DESC`,
    p.values,
  );
}

/** Daily opened/merged counts for the Pulse trend chart. */
export async function pulseDaily(
  db: Database,
  repoIds: readonly number[],
  fromIso: string,
  toIso: string,
  logins: Logins = null,
): Promise<Array<{ day: string; opened: number; merged: number }>> {
  const p = new Params();
  const f1 = p.add(fromIso);
  const t1 = p.add(toIso);
  const ids1 = p.in(repoIds);
  const a1 = p.loginFilter("author", logins);
  const f2 = p.add(fromIso);
  const t2 = p.add(toIso);
  const ids2 = p.in(repoIds);
  const a2 = p.loginFilter("author", logins);
  return db.select(
    `SELECT day, SUM(opened) AS opened, SUM(merged) AS merged FROM (
       SELECT substr(created_at, 1, 10) AS day, 1 AS opened, 0 AS merged
       FROM pull_requests
       WHERE created_at >= ${f1} AND created_at <= ${t1} AND repo_id IN ${ids1}${a1}
       UNION ALL
       SELECT substr(merged_at, 1, 10) AS day, 0 AS opened, 1 AS merged
       FROM pull_requests
       WHERE merged_at >= ${f2} AND merged_at <= ${t2} AND repo_id IN ${ids2}${a2}
     )
     GROUP BY day
     ORDER BY day`,
    p.values,
  );
}

export async function mergedPrDurations(
  db: Database,
  repoIds: readonly number[],
  fromIso: string,
  toIso: string,
  logins: Logins = null,
): Promise<Array<{ hours: number }>> {
  const p = new Params();
  const f = p.add(fromIso);
  const t = p.add(toIso);
  const ids = p.in(repoIds);
  const author = p.loginFilter("author", logins);
  return db.select(
    `SELECT (julianday(merged_at) - julianday(created_at)) * 24.0 AS hours
     FROM pull_requests
     WHERE merged_at >= ${f} AND merged_at <= ${t} AND repo_id IN ${ids}${author}
       AND created_at IS NOT NULL`,
    p.values,
  );
}

/* ── Traffic (no contributor dimension exists) ──────────────────────────── */

export async function trafficDaily(
  db: Database,
  repoIds: readonly number[],
  fromDay: string,
  toDay: string,
): Promise<Array<{ day: string; kind: string; count: number; uniques: number }>> {
  const p = new Params();
  const f = p.add(fromDay);
  const t = p.add(toDay);
  const ids = p.in(repoIds);
  return db.select(
    `SELECT day, kind, SUM(count) AS count, SUM(uniques) AS uniques
     FROM traffic_daily
     WHERE day >= ${f} AND day <= ${t} AND repo_id IN ${ids}
     GROUP BY day, kind
     ORDER BY day`,
    p.values,
  );
}

export async function trafficByRepo(
  db: Database,
  repoIds: readonly number[],
  fromDay: string,
  toDay: string,
): Promise<
  Array<{
    full_name: string;
    views: number;
    view_uniques: number;
    clones: number;
    clone_uniques: number;
  }>
> {
  const p = new Params();
  // Named `fromP`/`toP` because `t` is also the table alias below.
  const fromP = p.add(fromDay);
  const toP = p.add(toDay);
  const ids = p.in(repoIds);
  return db.select(
    `SELECT r.full_name,
            SUM(CASE WHEN t.kind = 'view'  THEN t.count   ELSE 0 END) AS views,
            SUM(CASE WHEN t.kind = 'view'  THEN t.uniques ELSE 0 END) AS view_uniques,
            SUM(CASE WHEN t.kind = 'clone' THEN t.count   ELSE 0 END) AS clones,
            SUM(CASE WHEN t.kind = 'clone' THEN t.uniques ELSE 0 END) AS clone_uniques
     FROM traffic_daily t
     JOIN repos r ON r.id = t.repo_id
     WHERE t.day >= ${fromP} AND t.day <= ${toP} AND t.repo_id IN ${ids}
     GROUP BY r.full_name
     ORDER BY views DESC`,
    p.values,
  );
}

/** Latest snapshot per repository, so repeated syncs do not multiply the counts. */
export async function topTrafficPaths(
  db: Database,
  repoIds: readonly number[],
  limit = 20,
): Promise<Array<{ path: string; title: string | null; count: number; uniques: number }>> {
  const p = new Params();
  const ids = p.in(repoIds);
  const lim = p.add(limit);
  return db.select(
    `WITH latest AS (
       SELECT repo_id, MAX(snapshot_day) AS d FROM traffic_paths
       WHERE repo_id IN ${ids} GROUP BY repo_id
     )
     SELECT tp.path, tp.title, SUM(tp.count) AS count, SUM(tp.uniques) AS uniques
     FROM traffic_paths tp
     JOIN latest l ON l.repo_id = tp.repo_id AND l.d = tp.snapshot_day
     GROUP BY tp.path, tp.title
     ORDER BY count DESC
     LIMIT ${lim}`,
    p.values,
  );
}

export async function topTrafficReferrers(
  db: Database,
  repoIds: readonly number[],
  limit = 20,
): Promise<Array<{ referrer: string; count: number; uniques: number }>> {
  const p = new Params();
  const ids = p.in(repoIds);
  const lim = p.add(limit);
  return db.select(
    `WITH latest AS (
       SELECT repo_id, MAX(snapshot_day) AS d FROM traffic_referrers
       WHERE repo_id IN ${ids} GROUP BY repo_id
     )
     SELECT tr.referrer, SUM(tr.count) AS count, SUM(tr.uniques) AS uniques
     FROM traffic_referrers tr
     JOIN latest l ON l.repo_id = tr.repo_id AND l.d = tr.snapshot_day
     GROUP BY tr.referrer
     ORDER BY count DESC
     LIMIT ${lim}`,
    p.values,
  );
}

/* ── Community ──────────────────────────────────────────────────────────── */

export interface CommunityRow {
  id: number;
  full_name: string;
  health: number;
  has_readme: number;
  has_license: number;
  has_coc: number;
  has_contrib: number;
  has_issue_tpl: number;
  has_pr_tpl: number;
  has_security: number;
  has_desc: number;
}

export async function communityRows(
  db: Database,
  repoIds: readonly number[],
): Promise<CommunityRow[]> {
  const p = new Params();
  const ids = p.in(repoIds);
  return db.select<CommunityRow[]>(
    `SELECT r.id, r.full_name,
            COALESCE(c.health, 0) AS health,
            COALESCE(c.has_readme, 0) AS has_readme,
            COALESCE(c.has_license, 0) AS has_license,
            COALESCE(c.has_coc, 0) AS has_coc,
            COALESCE(c.has_contrib, 0) AS has_contrib,
            COALESCE(c.has_issue_tpl, 0) AS has_issue_tpl,
            COALESCE(c.has_pr_tpl, 0) AS has_pr_tpl,
            COALESCE(c.has_security, 0) AS has_security,
            COALESCE(c.has_desc, 0) AS has_desc
     FROM repos r
     LEFT JOIN community c ON c.repo_id = r.id
     WHERE r.id IN ${ids}
     ORDER BY health DESC, r.full_name`,
    p.values,
  );
}

/* ── Forks & branches ───────────────────────────────────────────────────── */

/**
 * Forks of the selected repositories. `logins` filters by *fork owner*, which is a
 * different notion from a contributor — pages say so.
 */
export async function forkRows(
  db: Database,
  repoIds: readonly number[],
  logins: Logins = null,
): Promise<
  Array<{
    parent: string;
    full_name: string;
    owner_login: string | null;
    created_at: string | null;
    pushed_at: string | null;
    stars: number;
    html_url: string | null;
  }>
> {
  const p = new Params();
  const ids = p.in(repoIds);
  const owner = p.loginFilter("f.owner_login", logins);
  return db.select(
    `SELECT r.full_name AS parent, f.full_name, f.owner_login, f.created_at, f.pushed_at, f.stars, f.html_url
     FROM forks f
     JOIN repos r ON r.id = f.repo_id
     WHERE f.repo_id IN ${ids}${owner}
     ORDER BY f.created_at DESC`,
    p.values,
  );
}

export async function branchCounts(
  db: Database,
  repoIds: readonly number[],
): Promise<
  Array<{
    id: number;
    full_name: string;
    default_branch: string | null;
    branches: number;
    protected_branches: number;
  }>
> {
  const p = new Params();
  const ids = p.in(repoIds);
  return db.select(
    `SELECT r.id, r.full_name, r.default_branch,
            COUNT(b.name) AS branches,
            SUM(b.protected) AS protected_branches
     FROM repos r
     LEFT JOIN branches b ON b.repo_id = r.id
     WHERE r.id IN ${ids}
     GROUP BY r.id, r.full_name, r.default_branch
     ORDER BY branches DESC`,
    p.values,
  );
}

/* ── Dependencies ───────────────────────────────────────────────────────── */

export async function dependencyTotals(
  db: Database,
  repoIds: readonly number[],
): Promise<Array<{ ecosystem: string; packages: number; repos: number }>> {
  const p = new Params();
  const ids = p.in(repoIds);
  return db.select(
    `SELECT ecosystem, COUNT(DISTINCT package) AS packages, COUNT(DISTINCT repo_id) AS repos
     FROM dependencies
     WHERE repo_id IN ${ids}
     GROUP BY ecosystem
     ORDER BY packages DESC`,
    p.values,
  );
}

/** Most-depended-on packages across the org — the view a single repo cannot give. */
export async function topDependencies(
  db: Database,
  repoIds: readonly number[],
  limit = 50,
): Promise<Array<{ ecosystem: string; package: string; repos: number; versions: number }>> {
  const p = new Params();
  const ids = p.in(repoIds);
  const lim = p.add(limit);
  return db.select(
    `SELECT ecosystem, package,
            COUNT(DISTINCT repo_id) AS repos,
            COUNT(DISTINCT version) AS versions
     FROM dependencies
     WHERE repo_id IN ${ids}
     GROUP BY ecosystem, package
     ORDER BY repos DESC, package
     LIMIT ${lim}`,
    p.values,
  );
}

/** Packages pinned to differing versions across repositories — a drift signal. */
export async function dependencyDrift(
  db: Database,
  repoIds: readonly number[],
  limit = 40,
): Promise<
  Array<{
    ecosystem: string;
    package: string;
    versions: number;
    repos: number;
    version_list: string;
  }>
> {
  const p = new Params();
  const ids = p.in(repoIds);
  const lim = p.add(limit);
  return db.select(
    `SELECT ecosystem, package,
            COUNT(DISTINCT version) AS versions,
            COUNT(DISTINCT repo_id) AS repos,
            GROUP_CONCAT(DISTINCT version) AS version_list
     FROM dependencies
     WHERE repo_id IN ${ids} AND version IS NOT NULL
     GROUP BY ecosystem, package
     HAVING versions > 1
     ORDER BY versions DESC, repos DESC
     LIMIT ${lim}`,
    p.values,
  );
}

/* ── Actions (no actor stored yet; see README) ──────────────────────────── */

export interface ActionsSummary {
  runs: number;
  success: number;
  failure: number;
  cancelled: number;
  totalMs: number;
}

export async function actionsSummary(
  db: Database,
  repoIds: readonly number[],
  fromIso: string,
  toIso: string,
): Promise<ActionsSummary> {
  const p = new Params();
  const f = p.add(fromIso);
  const t = p.add(toIso);
  const ids = p.in(repoIds);
  const rows = await db.select<
    Array<{ runs: number; success: number; failure: number; cancelled: number; total_ms: number }>
  >(
    `SELECT COUNT(*) AS runs,
            SUM(CASE WHEN conclusion = 'success'   THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN conclusion = 'failure'   THEN 1 ELSE 0 END) AS failure,
            SUM(CASE WHEN conclusion = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            COALESCE(SUM(duration_ms), 0) AS total_ms
     FROM workflow_runs
     WHERE created_at >= ${f} AND created_at <= ${t} AND repo_id IN ${ids}`,
    p.values,
  );
  const r = rows[0];
  return {
    runs: r?.runs ?? 0,
    success: r?.success ?? 0,
    failure: r?.failure ?? 0,
    cancelled: r?.cancelled ?? 0,
    totalMs: r?.total_ms ?? 0,
  };
}

export async function actionsDaily(
  db: Database,
  repoIds: readonly number[],
  fromIso: string,
  toIso: string,
): Promise<Array<{ day: string; runs: number; success: number; failure: number; total_ms: number }>> {
  const p = new Params();
  const f = p.add(fromIso);
  const t = p.add(toIso);
  const ids = p.in(repoIds);
  return db.select(
    `SELECT substr(created_at, 1, 10) AS day,
            COUNT(*) AS runs,
            SUM(CASE WHEN conclusion = 'success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN conclusion = 'failure' THEN 1 ELSE 0 END) AS failure,
            COALESCE(SUM(duration_ms), 0) AS total_ms
     FROM workflow_runs
     WHERE created_at >= ${f} AND created_at <= ${t} AND repo_id IN ${ids}
     GROUP BY day
     ORDER BY day`,
    p.values,
  );
}

/** Per-workflow performance. Durations are returned raw so percentiles are exact. */
export async function workflowDurations(
  db: Database,
  repoIds: readonly number[],
  fromIso: string,
  toIso: string,
): Promise<
  Array<{ full_name: string; name: string | null; duration_ms: number; conclusion: string | null }>
> {
  const p = new Params();
  const f = p.add(fromIso);
  const t = p.add(toIso);
  const ids = p.in(repoIds);
  return db.select(
    `SELECT r.full_name, w.name, w.duration_ms, w.conclusion
     FROM workflow_runs w
     JOIN repos r ON r.id = w.repo_id
     WHERE w.created_at >= ${f} AND w.created_at <= ${t} AND w.repo_id IN ${ids}
       AND w.duration_ms IS NOT NULL`,
    p.values,
  );
}

/* ── Sync status ────────────────────────────────────────────────────────── */

export async function syncOverview(
  db: Database,
): Promise<Array<{ endpoint: string; status: string; n: number }>> {
  return db.select(
    "SELECT endpoint, status, COUNT(*) AS n FROM sync_state GROUP BY endpoint, status",
  );
}

export interface RepoEndpointStatus {
  repo_id: number;
  endpoint: string;
  status: string;
  error: string | null;
  last_ok_at: string | null;
}

/**
 * Every recorded (repository, endpoint) outcome, for the per-repository sync
 * controls. Returned unaggregated so the UI can say exactly which parts of a
 * repository are outstanding, rather than only how many.
 *
 * At ~80 repositories × 12 endpoints this tops out under a thousand rows, so
 * aggregating in SQL would cost more in round trips than it saves.
 */
export async function repoEndpointStatus(
  db: Database,
  repoIds: readonly number[],
): Promise<RepoEndpointStatus[]> {
  const p = new Params();
  const ids = p.in(repoIds);
  return db.select<RepoEndpointStatus[]>(
    `SELECT repo_id, endpoint, status, error, last_ok_at
     FROM sync_state
     WHERE repo_id IN ${ids}`,
    p.values,
  );
}

export interface OutstandingWork {
  /** (repo, endpoint) pairs a previous run finished. */
  complete: number;
  /** GitHub was still computing these; retrying usually succeeds. */
  pending: number;
  /** Failed for some other reason. */
  errored: number;
  /** Never attempted — new repositories, or a run that stopped early. */
  never: number;
  /** pending + errored + never: what a resume would actually do. */
  outstanding: number;
  /** True when there is finished work worth preserving. */
  resumable: boolean;
}

/**
 * How much of a sync remains, for the selected repositories and endpoints.
 *
 * Lets the UI offer "resume" honestly — saying how much would be skipped and how
 * much re-fetched — rather than making the user run a sync to find out.
 */
export async function outstandingWork(
  db: Database,
  repoIds: readonly number[],
  endpoints: readonly string[],
): Promise<OutstandingWork> {
  const expected = repoIds.length * endpoints.length;
  if (expected === 0) {
    return { complete: 0, pending: 0, errored: 0, never: 0, outstanding: 0, resumable: false };
  }

  const p = new Params();
  const ids = p.in(repoIds);
  const eps = p.in(endpoints);
  const rows = await db.select<Array<{ status: string; n: number }>>(
    `SELECT status, COUNT(*) AS n
     FROM sync_state
     WHERE repo_id IN ${ids} AND endpoint IN ${eps}
     GROUP BY status`,
    p.values,
  );

  const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
  const complete =
    (by.get("ok") ?? 0) + (by.get("empty") ?? 0) + (by.get("forbidden") ?? 0);
  const pending = by.get("pending") ?? 0;
  const errored = by.get("error") ?? 0;
  const recorded = complete + pending + errored;
  const never = Math.max(0, expected - recorded);

  return {
    complete,
    pending,
    errored,
    never,
    outstanding: pending + errored + never,
    resumable: complete > 0 && pending + errored + never > 0,
  };
}

export async function syncProblems(
  db: Database,
): Promise<Array<{ full_name: string; endpoint: string; status: string; error: string | null }>> {
  return db.select(
    `SELECT r.full_name, s.endpoint, s.status, s.error
     FROM sync_state s
     JOIN repos r ON r.id = s.repo_id
     WHERE s.status IN ('pending', 'error')
     ORDER BY s.endpoint, r.full_name`,
  );
}
