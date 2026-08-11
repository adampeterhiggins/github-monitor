import type Database from "@tauri-apps/plugin-sql";

/**
 * Read layer. Every query takes an explicit list of repo ids, which is how the
 * repo filter works: GitHub scopes Insights to one repository, here the same
 * aggregations run over whatever subset the user has selected.
 *
 * Aggregation happens in SQL rather than JavaScript — summing ~300k weekly rows
 * per page view in the renderer would be needlessly slow.
 */

/** Build a positional `IN (...)` fragment starting at `$offset`. */
function inClause(ids: number[], offset = 1): { sql: string; params: number[] } {
  if (ids.length === 0) return { sql: "(NULL)", params: [] };
  const placeholders = ids.map((_, i) => `$${offset + i}`).join(", ");
  return { sql: `(${placeholders})`, params: ids };
}

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
  const where = owner ? "WHERE r.owner = $1" : "";
  return db.select<RepoRow[]>(
    `SELECT r.*, COALESCE(s.included, 1) AS included
     FROM repos r
     LEFT JOIN repo_selection s ON s.repo_id = r.id
     ${where}
     ORDER BY r.pushed_at DESC NULLS LAST`,
    owner ? [owner] : [],
  );
}

export async function setRepoSelection(
  db: Database,
  selections: Array<{ repoId: number; included: boolean }>,
): Promise<void> {
  if (!selections.length) return;
  await db.execute("BEGIN");
  try {
    for (const s of selections) {
      await db.execute(
        `INSERT INTO repo_selection (repo_id, included) VALUES ($1, $2)
         ON CONFLICT (repo_id) DO UPDATE SET included = excluded.included`,
        [s.repoId, s.included ? 1 : 0],
      );
    }
    await db.execute("COMMIT");
  } catch (err) {
    await db.execute("ROLLBACK");
    throw err;
  }
}

/* ── Contributors ───────────────────────────────────────────────────────── */

export interface WeekPoint {
  week: number;
  commits: number;
  additions: number;
  deletions: number;
}

/** Org-wide weekly totals across the selected repos. */
export async function contributorWeeklyTotals(
  db: Database,
  repoIds: number[],
  fromWeek: number,
  toWeek: number,
): Promise<WeekPoint[]> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select<WeekPoint[]>(
    `SELECT week,
            SUM(commits)   AS commits,
            SUM(additions) AS additions,
            SUM(deletions) AS deletions
     FROM contributor_weeks
     WHERE week >= $1 AND week <= $2 AND repo_id IN ${sql}
     GROUP BY week
     ORDER BY week`,
    [fromWeek, toWeek, ...params],
  );
}

export interface ContributorWeekRow extends WeekPoint {
  login: string;
}

/**
 * Per-contributor weekly rows, already summed across repos. The caller groups
 * these into cards; doing it in one query avoids N queries for N contributors.
 */
export async function contributorWeeklyByLogin(
  db: Database,
  repoIds: number[],
  fromWeek: number,
  toWeek: number,
): Promise<ContributorWeekRow[]> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select<ContributorWeekRow[]>(
    `SELECT login, week,
            SUM(commits)   AS commits,
            SUM(additions) AS additions,
            SUM(deletions) AS deletions
     FROM contributor_weeks
     WHERE week >= $1 AND week <= $2 AND repo_id IN ${sql}
     GROUP BY login, week
     ORDER BY login, week`,
    [fromWeek, toWeek, ...params],
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

/** Per-repo totals for one contributor — powers the drill-down on a card. */
export async function contributorRepoBreakdown(
  db: Database,
  login: string,
  repoIds: number[],
  fromWeek: number,
  toWeek: number,
): Promise<Array<{ full_name: string; commits: number; additions: number; deletions: number }>> {
  const { sql, params } = inClause(repoIds, 4);
  return db.select(
    `SELECT r.full_name,
            SUM(cw.commits)   AS commits,
            SUM(cw.additions) AS additions,
            SUM(cw.deletions) AS deletions
     FROM contributor_weeks cw
     JOIN repos r ON r.id = cw.repo_id
     WHERE cw.login = $1 AND cw.week >= $2 AND cw.week <= $3 AND cw.repo_id IN ${sql}
     GROUP BY r.full_name
     HAVING commits > 0
     ORDER BY commits DESC`,
    [login, fromWeek, toWeek, ...params],
  );
}

/** Earliest week with any data, for resolving the "all time" period. */
export async function earliestWeek(db: Database, repoIds: number[]): Promise<number | null> {
  const { sql, params } = inClause(repoIds, 1);
  const rows = await db.select<Array<{ w: number | null }>>(
    `SELECT MIN(week) AS w FROM contributor_weeks WHERE repo_id IN ${sql}`,
    params,
  );
  return rows[0]?.w ?? null;
}

/* ── Commits / code frequency / punchcard ───────────────────────────────── */

export async function commitActivityDaily(
  db: Database,
  repoIds: number[],
  fromWeek: number,
  toWeek: number,
): Promise<Array<{ week: number; dow: number; commits: number }>> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select(
    `SELECT week, dow, SUM(commits) AS commits
     FROM commit_activity
     WHERE week >= $1 AND week <= $2 AND repo_id IN ${sql}
     GROUP BY week, dow
     ORDER BY week, dow`,
    [fromWeek, toWeek, ...params],
  );
}

export async function codeFrequencyWeekly(
  db: Database,
  repoIds: number[],
  fromWeek: number,
  toWeek: number,
): Promise<Array<{ week: number; additions: number; deletions: number }>> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select(
    `SELECT week, SUM(additions) AS additions, SUM(deletions) AS deletions
     FROM code_frequency
     WHERE week >= $1 AND week <= $2 AND repo_id IN ${sql}
     GROUP BY week
     ORDER BY week`,
    [fromWeek, toWeek, ...params],
  );
}

export async function punchcardTotals(
  db: Database,
  repoIds: number[],
): Promise<Array<{ dow: number; hour: number; commits: number }>> {
  const { sql, params } = inClause(repoIds, 1);
  return db.select(
    `SELECT dow, hour, SUM(commits) AS commits
     FROM punchcard
     WHERE repo_id IN ${sql}
     GROUP BY dow, hour`,
    params,
  );
}

/** Per-repo commit totals, for the repo-breakdown table on the Commits page. */
export async function commitsByRepo(
  db: Database,
  repoIds: number[],
  fromWeek: number,
  toWeek: number,
): Promise<Array<{ id: number; full_name: string; commits: number; additions: number; deletions: number }>> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select(
    `SELECT r.id, r.full_name,
            SUM(cw.commits)   AS commits,
            SUM(cw.additions) AS additions,
            SUM(cw.deletions) AS deletions
     FROM contributor_weeks cw
     JOIN repos r ON r.id = cw.repo_id
     WHERE cw.week >= $1 AND cw.week <= $2 AND cw.repo_id IN ${sql}
     GROUP BY r.id, r.full_name
     ORDER BY commits DESC`,
    [fromWeek, toWeek, ...params],
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
  repoIds: number[],
  fromIso: string,
  toIso: string,
  fromWeek: number,
  toWeek: number,
): Promise<PulseSummary> {
  const pr = inClause(repoIds, 3);
  const rows = await db.select<
    Array<{
      prs_opened: number;
      prs_merged: number;
      prs_closed_unmerged: number;
      pr_authors: number;
    }>
  >(
    `SELECT
       SUM(CASE WHEN created_at >= $1 AND created_at <= $2 THEN 1 ELSE 0 END) AS prs_opened,
       SUM(CASE WHEN merged_at  >= $1 AND merged_at  <= $2 THEN 1 ELSE 0 END) AS prs_merged,
       SUM(CASE WHEN closed_at  >= $1 AND closed_at  <= $2 AND merged_at IS NULL THEN 1 ELSE 0 END)
         AS prs_closed_unmerged,
       COUNT(DISTINCT CASE WHEN created_at >= $1 AND created_at <= $2 THEN author END) AS pr_authors
     FROM pull_requests
     WHERE repo_id IN ${pr.sql}`,
    [fromIso, toIso, ...pr.params],
  );

  const iss = inClause(repoIds, 3);
  const issueRows = await db.select<Array<{ opened: number; closed: number }>>(
    `SELECT
       SUM(CASE WHEN created_at >= $1 AND created_at <= $2 THEN 1 ELSE 0 END) AS opened,
       SUM(CASE WHEN closed_at  >= $1 AND closed_at  <= $2 THEN 1 ELSE 0 END) AS closed
     FROM issues
     WHERE repo_id IN ${iss.sql}`,
    [fromIso, toIso, ...iss.params],
  );

  const cw = inClause(repoIds, 3);
  const commitRows = await db.select<
    Array<{ commits: number; authors: number; repos_active: number }>
  >(
    `SELECT COALESCE(SUM(commits), 0) AS commits,
            COUNT(DISTINCT login)     AS authors,
            COUNT(DISTINCT repo_id)   AS repos_active
     FROM contributor_weeks
     WHERE week >= $1 AND week <= $2 AND repo_id IN ${cw.sql}`,
    [fromWeek, toWeek, ...cw.params],
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
  repoIds: number[],
  fromIso: string,
  toIso: string,
): Promise<Array<{ full_name: string; prs_opened: number; prs_merged: number; issues_opened: number; issues_closed: number }>> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select(
    `SELECT r.full_name,
            COALESCE(p.prs_opened, 0)    AS prs_opened,
            COALESCE(p.prs_merged, 0)    AS prs_merged,
            COALESCE(i.issues_opened, 0) AS issues_opened,
            COALESCE(i.issues_closed, 0) AS issues_closed
     FROM repos r
     LEFT JOIN (
       SELECT repo_id,
              SUM(CASE WHEN created_at >= $1 AND created_at <= $2 THEN 1 ELSE 0 END) AS prs_opened,
              SUM(CASE WHEN merged_at  >= $1 AND merged_at  <= $2 THEN 1 ELSE 0 END) AS prs_merged
       FROM pull_requests GROUP BY repo_id
     ) p ON p.repo_id = r.id
     LEFT JOIN (
       SELECT repo_id,
              SUM(CASE WHEN created_at >= $1 AND created_at <= $2 THEN 1 ELSE 0 END) AS issues_opened,
              SUM(CASE WHEN closed_at  >= $1 AND closed_at  <= $2 THEN 1 ELSE 0 END) AS issues_closed
       FROM issues GROUP BY repo_id
     ) i ON i.repo_id = r.id
     WHERE r.id IN ${sql}
       AND (p.prs_opened > 0 OR p.prs_merged > 0 OR i.issues_opened > 0 OR i.issues_closed > 0)
     ORDER BY prs_merged DESC, prs_opened DESC`,
    [fromIso, toIso, ...params],
  );
}

/** Merged-PR authors ranked, plus review counts — the "who reviewed" half of Pulse. */
export async function pulseAuthors(
  db: Database,
  repoIds: number[],
  fromIso: string,
  toIso: string,
): Promise<Array<{ author: string; prs_opened: number; prs_merged: number; reviews: number }>> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select(
    `SELECT author,
            SUM(CASE WHEN created_at >= $1 AND created_at <= $2 THEN 1 ELSE 0 END) AS prs_opened,
            SUM(CASE WHEN merged_at  >= $1 AND merged_at  <= $2 THEN 1 ELSE 0 END) AS prs_merged,
            SUM(CASE WHEN created_at >= $1 AND created_at <= $2 THEN reviews ELSE 0 END) AS reviews
     FROM pull_requests
     WHERE author IS NOT NULL AND repo_id IN ${sql}
     GROUP BY author
     HAVING prs_opened > 0 OR prs_merged > 0
     ORDER BY prs_merged DESC, prs_opened DESC`,
    [fromIso, toIso, ...params],
  );
}

/** Daily opened/merged counts for the Pulse trend chart. */
export async function pulseDaily(
  db: Database,
  repoIds: number[],
  fromIso: string,
  toIso: string,
): Promise<Array<{ day: string; opened: number; merged: number }>> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select(
    `SELECT day, SUM(opened) AS opened, SUM(merged) AS merged FROM (
       SELECT substr(created_at, 1, 10) AS day, 1 AS opened, 0 AS merged
       FROM pull_requests
       WHERE created_at >= $1 AND created_at <= $2 AND repo_id IN ${sql}
       UNION ALL
       SELECT substr(merged_at, 1, 10) AS day, 0 AS opened, 1 AS merged
       FROM pull_requests
       WHERE merged_at >= $1 AND merged_at <= $2 AND repo_id IN ${sql}
     )
     GROUP BY day
     ORDER BY day`,
    [fromIso, toIso, ...params, ...params],
  );
}

/** PR lead time (open -> merge) percentiles are computed in JS from these. */
export async function mergedPrDurations(
  db: Database,
  repoIds: number[],
  fromIso: string,
  toIso: string,
): Promise<Array<{ hours: number }>> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select(
    `SELECT (julianday(merged_at) - julianday(created_at)) * 24.0 AS hours
     FROM pull_requests
     WHERE merged_at >= $1 AND merged_at <= $2 AND repo_id IN ${sql}
       AND created_at IS NOT NULL`,
    [fromIso, toIso, ...params],
  );
}

/* ── Traffic ────────────────────────────────────────────────────────────── */

export async function trafficDaily(
  db: Database,
  repoIds: number[],
  fromDay: string,
  toDay: string,
): Promise<Array<{ day: string; kind: string; count: number; uniques: number }>> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select(
    `SELECT day, kind, SUM(count) AS count, SUM(uniques) AS uniques
     FROM traffic_daily
     WHERE day >= $1 AND day <= $2 AND repo_id IN ${sql}
     GROUP BY day, kind
     ORDER BY day`,
    [fromDay, toDay, ...params],
  );
}

export async function trafficByRepo(
  db: Database,
  repoIds: number[],
  fromDay: string,
  toDay: string,
): Promise<Array<{ full_name: string; views: number; view_uniques: number; clones: number; clone_uniques: number }>> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select(
    `SELECT r.full_name,
            SUM(CASE WHEN t.kind = 'view'  THEN t.count   ELSE 0 END) AS views,
            SUM(CASE WHEN t.kind = 'view'  THEN t.uniques ELSE 0 END) AS view_uniques,
            SUM(CASE WHEN t.kind = 'clone' THEN t.count   ELSE 0 END) AS clones,
            SUM(CASE WHEN t.kind = 'clone' THEN t.uniques ELSE 0 END) AS clone_uniques
     FROM traffic_daily t
     JOIN repos r ON r.id = t.repo_id
     WHERE t.day >= $1 AND t.day <= $2 AND t.repo_id IN ${sql}
     GROUP BY r.full_name
     ORDER BY views DESC`,
    [fromDay, toDay, ...params],
  );
}

/** Latest snapshot per repo, so repeated syncs do not multiply the counts. */
export async function topTrafficPaths(
  db: Database,
  repoIds: number[],
  limit = 20,
): Promise<Array<{ path: string; title: string | null; count: number; uniques: number }>> {
  const { sql, params } = inClause(repoIds, 1);
  return db.select(
    `WITH latest AS (
       SELECT repo_id, MAX(snapshot_day) AS d FROM traffic_paths
       WHERE repo_id IN ${sql} GROUP BY repo_id
     )
     SELECT tp.path, tp.title, SUM(tp.count) AS count, SUM(tp.uniques) AS uniques
     FROM traffic_paths tp
     JOIN latest l ON l.repo_id = tp.repo_id AND l.d = tp.snapshot_day
     GROUP BY tp.path, tp.title
     ORDER BY count DESC
     LIMIT $${params.length + 1}`,
    [...params, limit],
  );
}

export async function topTrafficReferrers(
  db: Database,
  repoIds: number[],
  limit = 20,
): Promise<Array<{ referrer: string; count: number; uniques: number }>> {
  const { sql, params } = inClause(repoIds, 1);
  return db.select(
    `WITH latest AS (
       SELECT repo_id, MAX(snapshot_day) AS d FROM traffic_referrers
       WHERE repo_id IN ${sql} GROUP BY repo_id
     )
     SELECT tr.referrer, SUM(tr.count) AS count, SUM(tr.uniques) AS uniques
     FROM traffic_referrers tr
     JOIN latest l ON l.repo_id = tr.repo_id AND l.d = tr.snapshot_day
     GROUP BY tr.referrer
     ORDER BY count DESC
     LIMIT $${params.length + 1}`,
    [...params, limit],
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

export async function communityRows(db: Database, repoIds: number[]): Promise<CommunityRow[]> {
  const { sql, params } = inClause(repoIds, 1);
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
     WHERE r.id IN ${sql}
     ORDER BY health DESC, r.full_name`,
    params,
  );
}

/* ── Forks & branches ───────────────────────────────────────────────────── */

export async function forkRows(
  db: Database,
  repoIds: number[],
): Promise<Array<{ parent: string; full_name: string; owner_login: string | null; created_at: string | null; pushed_at: string | null; stars: number; html_url: string | null }>> {
  const { sql, params } = inClause(repoIds, 1);
  return db.select(
    `SELECT r.full_name AS parent, f.full_name, f.owner_login, f.created_at, f.pushed_at, f.stars, f.html_url
     FROM forks f
     JOIN repos r ON r.id = f.repo_id
     WHERE f.repo_id IN ${sql}
     ORDER BY f.created_at DESC`,
    params,
  );
}

export async function branchCounts(
  db: Database,
  repoIds: number[],
): Promise<Array<{ id: number; full_name: string; default_branch: string | null; branches: number; protected_branches: number }>> {
  const { sql, params } = inClause(repoIds, 1);
  return db.select(
    `SELECT r.id, r.full_name, r.default_branch,
            COUNT(b.name) AS branches,
            SUM(b.protected) AS protected_branches
     FROM repos r
     LEFT JOIN branches b ON b.repo_id = r.id
     WHERE r.id IN ${sql}
     GROUP BY r.id, r.full_name, r.default_branch
     ORDER BY branches DESC`,
    params,
  );
}

/* ── Dependencies ───────────────────────────────────────────────────────── */

export async function dependencyTotals(
  db: Database,
  repoIds: number[],
): Promise<Array<{ ecosystem: string; packages: number; repos: number }>> {
  const { sql, params } = inClause(repoIds, 1);
  return db.select(
    `SELECT ecosystem, COUNT(DISTINCT package) AS packages, COUNT(DISTINCT repo_id) AS repos
     FROM dependencies
     WHERE repo_id IN ${sql}
     GROUP BY ecosystem
     ORDER BY packages DESC`,
    params,
  );
}

/** Most-depended-on packages across the org — the view a single repo cannot give. */
export async function topDependencies(
  db: Database,
  repoIds: number[],
  limit = 50,
): Promise<Array<{ ecosystem: string; package: string; repos: number; versions: number }>> {
  const { sql, params } = inClause(repoIds, 1);
  return db.select(
    `SELECT ecosystem, package,
            COUNT(DISTINCT repo_id) AS repos,
            COUNT(DISTINCT version) AS versions
     FROM dependencies
     WHERE repo_id IN ${sql}
     GROUP BY ecosystem, package
     ORDER BY repos DESC, package
     LIMIT $${params.length + 1}`,
    [...params, limit],
  );
}

/** Packages pinned to differing versions across repos — a drift signal. */
export async function dependencyDrift(
  db: Database,
  repoIds: number[],
  limit = 40,
): Promise<Array<{ ecosystem: string; package: string; versions: number; repos: number; version_list: string }>> {
  const { sql, params } = inClause(repoIds, 1);
  return db.select(
    `SELECT ecosystem, package,
            COUNT(DISTINCT version) AS versions,
            COUNT(DISTINCT repo_id) AS repos,
            GROUP_CONCAT(DISTINCT version) AS version_list
     FROM dependencies
     WHERE repo_id IN ${sql} AND version IS NOT NULL
     GROUP BY ecosystem, package
     HAVING versions > 1
     ORDER BY versions DESC, repos DESC
     LIMIT $${params.length + 1}`,
    [...params, limit],
  );
}

/* ── Actions ────────────────────────────────────────────────────────────── */

export interface ActionsSummary {
  runs: number;
  success: number;
  failure: number;
  cancelled: number;
  totalMs: number;
}

export async function actionsSummary(
  db: Database,
  repoIds: number[],
  fromIso: string,
  toIso: string,
): Promise<ActionsSummary> {
  const { sql, params } = inClause(repoIds, 3);
  const rows = await db.select<
    Array<{ runs: number; success: number; failure: number; cancelled: number; total_ms: number }>
  >(
    `SELECT COUNT(*) AS runs,
            SUM(CASE WHEN conclusion = 'success'   THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN conclusion = 'failure'   THEN 1 ELSE 0 END) AS failure,
            SUM(CASE WHEN conclusion = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            COALESCE(SUM(duration_ms), 0) AS total_ms
     FROM workflow_runs
     WHERE created_at >= $1 AND created_at <= $2 AND repo_id IN ${sql}`,
    [fromIso, toIso, ...params],
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
  repoIds: number[],
  fromIso: string,
  toIso: string,
): Promise<Array<{ day: string; runs: number; success: number; failure: number; total_ms: number }>> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select(
    `SELECT substr(created_at, 1, 10) AS day,
            COUNT(*) AS runs,
            SUM(CASE WHEN conclusion = 'success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN conclusion = 'failure' THEN 1 ELSE 0 END) AS failure,
            COALESCE(SUM(duration_ms), 0) AS total_ms
     FROM workflow_runs
     WHERE created_at >= $1 AND created_at <= $2 AND repo_id IN ${sql}
     GROUP BY day
     ORDER BY day`,
    [fromIso, toIso, ...params],
  );
}

/** Per-workflow performance. Durations are returned raw so percentiles are exact. */
export async function workflowDurations(
  db: Database,
  repoIds: number[],
  fromIso: string,
  toIso: string,
): Promise<Array<{ full_name: string; name: string | null; duration_ms: number; conclusion: string | null }>> {
  const { sql, params } = inClause(repoIds, 3);
  return db.select(
    `SELECT r.full_name, w.name, w.duration_ms, w.conclusion
     FROM workflow_runs w
     JOIN repos r ON r.id = w.repo_id
     WHERE w.created_at >= $1 AND w.created_at <= $2 AND w.repo_id IN ${sql}
       AND w.duration_ms IS NOT NULL`,
    [fromIso, toIso, ...params],
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
