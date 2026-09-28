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

/**
 * The name to show for a repository: bare while one organisation is in play, and
 * `owner/name` once there are several, where two could share a name.
 */
export function repoLabel(repo: Pick<RepoRow, "name" | "full_name">, multipleOrgs: boolean): string {
  return multipleOrgs ? repo.full_name : repo.name;
}

/**
 * Repositories owned by any of `owners`, or every cached repository when omitted.
 * Owners compare case-insensitively, as GitHub logins do, so a login typed with
 * different casing still finds what an earlier sync stored.
 */
export async function listRepos(db: Database, owners?: readonly string[]): Promise<RepoRow[]> {
  const p = new Params();
  const where = owners ? `WHERE LOWER(r.owner) IN ${p.in(owners.map((o) => o.toLowerCase()))}` : "";
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

/* ── Saved selections ───────────────────────────────────────────────────── */

export type SavedFilterKind = "repos" | "contributors";

export interface SavedFilter {
  id: number;
  kind: SavedFilterKind;
  name: string;
  /** Repo ids for `repos`, logins for `contributors`. */
  values: Array<number | string>;
  created_at: string | null;
  updated_at: string | null;
}

interface SavedFilterRow {
  id: number;
  kind: SavedFilterKind;
  name: string;
  payload: string;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Decode a stored selection.
 *
 * The payload is user-editable through the UI and survives schema changes, so a
 * malformed one must not take the whole list down with it — a single unreadable
 * selection becomes an empty one rather than an exception.
 */
function decodeSaved(row: SavedFilterRow): SavedFilter {
  let values: Array<number | string> = [];
  try {
    const parsed = JSON.parse(row.payload);
    if (Array.isArray(parsed)) {
      values = parsed.filter((v) => typeof v === "number" || typeof v === "string");
    }
  } catch {
    // Leave it empty; the UI shows the count, so an empty one is visibly wrong.
  }
  return { ...row, values };
}

export async function listSavedFilters(
  db: Database,
  kind?: SavedFilterKind,
): Promise<SavedFilter[]> {
  const p = new Params();
  const where = kind ? `WHERE kind = ${p.add(kind)}` : "";
  const rows = await db.select<SavedFilterRow[]>(
    `SELECT id, kind, name, payload, created_at, updated_at
     FROM saved_filters ${where}
     ORDER BY name COLLATE NOCASE`,
    p.values,
  );
  return rows.map(decodeSaved);
}

/**
 * Create or replace a selection by name.
 *
 * Saving over an existing name updates it rather than adding a second entry that
 * looks identical in the list — the UNIQUE(kind, name) constraint makes that the
 * only sensible reading.
 */
export async function saveFilter(
  db: Database,
  kind: SavedFilterKind,
  name: string,
  values: Array<number | string>,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A saved selection needs a name.");
  const now = new Date().toISOString();
  await withWriteLock(() =>
    db.execute(
      `INSERT INTO saved_filters (kind, name, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (kind, name) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [kind, trimmed, JSON.stringify(values), now],
    ),
  );
}

export async function renameSavedFilter(db: Database, id: number, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A saved selection needs a name.");
  await withWriteLock(() =>
    db.execute("UPDATE saved_filters SET name = $1, updated_at = $2 WHERE id = $3", [
      trimmed,
      new Date().toISOString(),
      id,
    ]),
  );
}

export async function updateSavedFilterValues(
  db: Database,
  id: number,
  values: Array<number | string>,
): Promise<void> {
  await withWriteLock(() =>
    db.execute("UPDATE saved_filters SET payload = $1, updated_at = $2 WHERE id = $3", [
      JSON.stringify(values),
      new Date().toISOString(),
      id,
    ]),
  );
}

export async function deleteSavedFilter(db: Database, id: number): Promise<void> {
  await withWriteLock(() => db.execute("DELETE FROM saved_filters WHERE id = $1", [id]));
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

export interface ContributorBoundsRow {
  login: string;
  first_week: number;
  last_week: number;
}

/**
 * First and last week with commits, per contributor, across the selected repos.
 *
 * Deliberately unbounded by period: it exists to answer "what period would cover
 * everything this person did", so restricting it to the period on screen would
 * make it answer with the period it was given. One query for every card rather
 * than one per card, since two dozen are on screen at once.
 *
 * Casings are merged the way the rest of the read layer merges them — the cache's
 * key is case-sensitive and GitHub is not.
 */
export async function contributorWeekBounds(
  db: Database,
  repoIds: readonly number[],
): Promise<ContributorBoundsRow[]> {
  if (repoIds.length === 0) return [];
  const p = new Params();
  const ids = p.in(repoIds);
  return db.select<ContributorBoundsRow[]>(
    `SELECT MIN(login) AS login, MIN(week) AS first_week, MAX(week) AS last_week
     FROM contributor_weeks
     WHERE commits > 0 AND repo_id IN ${ids}
     GROUP BY LOWER(login)`,
    p.values,
  );
}

export interface ContributorRepoRow {
  login: string;
  repo_id: number;
}

/**
 * Which repositories each contributor has commits in, across the whole cache.
 *
 * Deliberately *not* scoped to the selected repositories, unlike almost everything
 * else here: it exists to set that selection, and a query that could only see the
 * current selection could only ever narrow it. Joined to `repos` so the ids it
 * returns are ones that still exist and can be selected.
 *
 * One row per contributor and repository, grouped by the caller — a few hundred
 * rows for an org of this size, and one query rather than one per card.
 */
export async function contributorRepoIds(db: Database): Promise<ContributorRepoRow[]> {
  return db.select<ContributorRepoRow[]>(
    `SELECT MIN(cw.login) AS login, cw.repo_id AS repo_id
     FROM contributor_weeks cw
     JOIN repos r ON r.id = cw.repo_id
     WHERE cw.commits > 0
     GROUP BY LOWER(cw.login), cw.repo_id`,
  );
}

export interface RepoStatsRow {
  repo_id: number;
  /** Null when the repository could not be read, as against read-and-empty. */
  commits: number | null;
  recent_commits: number | null;
  since: string | null;
  readable: number;
  checked_at: string | null;
}

/**
 * Pre-sync commit counts per repository.
 *
 * The counterpart to `repoActivity`, which reads what a sync has already landed.
 * This one is populated by `runPreSync` from two cheap requests per repository, so
 * it is available while deciding what to sync — which is exactly when
 * `repoActivity` is still empty.
 */
export async function getRepoStats(db: Database): Promise<RepoStatsRow[]> {
  return db.select<RepoStatsRow[]>(
    `SELECT repo_id, commits, recent_commits, since, readable, checked_at FROM repo_stats`,
  );
}

export async function saveRepoStats(
  db: Database,
  results: Array<{
    repoId: number;
    commits: number | null;
    recentCommits: number | null;
    since: string | null;
    readable: boolean;
  }>,
): Promise<void> {
  if (!results.length) return;
  const checkedAt = new Date().toISOString();
  await withWriteLock(() =>
    bulkInsert(db, {
      table: "repo_stats",
      columns: ["repo_id", "commits", "recent_commits", "since", "readable", "checked_at"],
      conflictColumns: ["repo_id"],
      rows: results.map((r) => [
        r.repoId,
        r.commits,
        r.recentCommits,
        r.since,
        r.readable ? 1 : 0,
        checkedAt,
      ]),
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
  /** Commits inside the selected period. */
  commits: number;
  additions: number;
  deletions: number;
  /** Distinct repositories touched inside the period. */
  repos: number;
  /** Commits across all time, so someone quiet now is still listed. */
  commits_all: number;
  last_week: number | null;
}

/**
 * Contributors in the selected repositories, for the contributor filter.
 *
 * Identity is deliberately *not* date-scoped while the aggregates are: someone
 * with no commits this period must still be listed, or they could never be
 * selected in order to look at their history. `commits` is therefore the period
 * figure the dropdown displays and filters on, and `commits_all` is what keeps
 * them present at all.
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
  /** Period bounds. Aggregates are scoped to these; identity is not. */
  fromWeek?: number,
  toWeek?: number,
): Promise<ContributorSummary[]> {
  const p = new Params();
  const ids = p.in(repoIds);
  // Unbounded defaults keep the aggregates equal to all time when no period is
  // given, so callers that do not care about a window need not pass one.
  const from = p.add(fromWeek ?? 0);
  const to = p.add(toWeek ?? Number.MAX_SAFE_INTEGER);

  return db.select<ContributorSummary[]>(
    `WITH agg AS (
       SELECT LOWER(login) AS key,
              MIN(login)   AS login,
              SUM(commits) AS commits_all,
              SUM(CASE WHEN week >= ${from} AND week <= ${to} THEN commits   ELSE 0 END) AS commits,
              SUM(CASE WHEN week >= ${from} AND week <= ${to} THEN additions ELSE 0 END) AS additions,
              SUM(CASE WHEN week >= ${from} AND week <= ${to} THEN deletions ELSE 0 END) AS deletions,
              COUNT(DISTINCT CASE WHEN week >= ${from} AND week <= ${to} THEN repo_id END) AS repos,
              MAX(week) AS last_week
       FROM contributor_weeks
       WHERE repo_id IN ${ids}
       GROUP BY LOWER(login)
     )
     SELECT a.login,
            (SELECT c.avatar_url FROM contributors c WHERE LOWER(c.login) = a.key LIMIT 1) AS avatar_url,
            (SELECT c.html_url   FROM contributors c WHERE LOWER(c.login) = a.key LIMIT 1) AS html_url,
            a.commits, a.additions, a.deletions, a.repos, a.commits_all, a.last_week
     FROM agg a
     WHERE a.commits_all > 0
     ORDER BY a.commits DESC, a.commits_all DESC`,
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

/**
 * The first and last week with any commits in the current selection, so a period
 * can be set to the data itself rather than to a guess.
 *
 * Weeks with no commits are ignored rather than counted as coverage: a repository
 * row can exist with zeroes, and a range that opened on an empty week would claim
 * history that is not there. Null when the selection has no commits at all.
 */
export async function commitWeekBounds(
  db: Database,
  repoIds: readonly number[],
  logins: Logins = null,
): Promise<{ firstWeek: number; lastWeek: number } | null> {
  if (repoIds.length === 0) return null;
  const p = new Params();
  const ids = p.in(repoIds);
  const loginClause = p.loginFilter("login", logins);
  const rows = await db.select<Array<{ first_week: number | null; last_week: number | null }>>(
    `SELECT MIN(week) AS first_week, MAX(week) AS last_week
     FROM contributor_weeks
     WHERE commits > 0 AND repo_id IN ${ids}${loginClause}`,
    p.values,
  );
  const first = rows[0]?.first_week;
  const last = rows[0]?.last_week;
  if (first == null || last == null) return null;
  return { firstWeek: Number(first), lastWeek: Number(last) };
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

export interface RepoWeekRow extends WeekPoint {
  repo_id: number;
  full_name: string;
}

/**
 * Weekly totals per repository — the repository breakdown of the org-wide chart.
 * Honours the contributor filter, so "these five people, split by repository" works.
 */
export async function weeklyByRepo(
  db: Database,
  repoIds: readonly number[],
  fromWeek: number,
  toWeek: number,
  logins: Logins = null,
): Promise<RepoWeekRow[]> {
  const p = new Params();
  const from = p.add(fromWeek);
  const to = p.add(toWeek);
  const ids = p.in(repoIds);
  const loginClause = p.loginFilter("cw.login", logins);
  return db.select<RepoWeekRow[]>(
    `SELECT cw.repo_id, r.full_name, cw.week,
            SUM(cw.commits)   AS commits,
            SUM(cw.additions) AS additions,
            SUM(cw.deletions) AS deletions
     FROM contributor_weeks cw
     JOIN repos r ON r.id = cw.repo_id
     WHERE cw.week >= ${from} AND cw.week <= ${to} AND cw.repo_id IN ${ids}${loginClause}
     GROUP BY cw.repo_id, r.full_name, cw.week
     ORDER BY cw.week`,
    p.values,
  );
}

export interface LoginRepoWeekRow extends RepoWeekRow {
  login: string;
}

/**
 * Weekly totals per contributor **and** repository, in one query.
 *
 * Backs the repository split across every contributor card at once. Doing it per
 * card would mean one query per visible contributor — two dozen round trips to
 * answer a single question — and the underlying table is already keyed by
 * (repo, login, week), so this is close to reading it directly.
 *
 * Login casings are merged here for the same reason as elsewhere: two casings of
 * one account would otherwise split into two sets of cards.
 */
export async function contributorRepoWeeklyAll(
  db: Database,
  repoIds: readonly number[],
  fromWeek: number,
  toWeek: number,
  logins: Logins = null,
): Promise<LoginRepoWeekRow[]> {
  const p = new Params();
  const from = p.add(fromWeek);
  const to = p.add(toWeek);
  const ids = p.in(repoIds);
  const loginClause = p.loginFilter("cw.login", logins);
  return db.select<LoginRepoWeekRow[]>(
    `SELECT MIN(cw.login) AS login, cw.repo_id, r.full_name, cw.week,
            SUM(cw.commits)   AS commits,
            SUM(cw.additions) AS additions,
            SUM(cw.deletions) AS deletions
     FROM contributor_weeks cw
     JOIN repos r ON r.id = cw.repo_id
     WHERE cw.week >= ${from} AND cw.week <= ${to} AND cw.repo_id IN ${ids}${loginClause}
     GROUP BY LOWER(cw.login), cw.repo_id, r.full_name, cw.week`,
    p.values,
  );
}

/**
 * Weekly totals per repository for one contributor — the repository breakdown of
 * an individual's card.
 */
export async function contributorWeeklyByRepo(
  db: Database,
  login: string,
  repoIds: readonly number[],
  fromWeek: number,
  toWeek: number,
): Promise<RepoWeekRow[]> {
  const p = new Params();
  const who = p.add(login);
  const from = p.add(fromWeek);
  const to = p.add(toWeek);
  const ids = p.in(repoIds);
  return db.select<RepoWeekRow[]>(
    `SELECT cw.repo_id, r.full_name, cw.week,
            SUM(cw.commits)   AS commits,
            SUM(cw.additions) AS additions,
            SUM(cw.deletions) AS deletions
     FROM contributor_weeks cw
     JOIN repos r ON r.id = cw.repo_id
     WHERE LOWER(cw.login) = LOWER(${who})
       AND cw.week >= ${from} AND cw.week <= ${to}
       AND cw.repo_id IN ${ids}
     GROUP BY cw.repo_id, r.full_name, cw.week
     ORDER BY cw.week`,
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

/**
 * Person × repository totals for the ownership matrix.
 *
 * One row per (login, repo) that had any commits in the window. Casings merge
 * for the same reason as elsewhere: two spellings of one account would otherwise
 * paint two rows that are the same person.
 */
export interface OwnershipCell {
  login: string;
  repo_id: number;
  full_name: string;
  commits: number;
  additions: number;
  deletions: number;
}

export async function ownershipCells(
  db: Database,
  repoIds: readonly number[],
  fromWeek: number,
  toWeek: number,
  logins: Logins = null,
): Promise<OwnershipCell[]> {
  const p = new Params();
  const from = p.add(fromWeek);
  const to = p.add(toWeek);
  const ids = p.in(repoIds);
  const loginClause = p.loginFilter("cw.login", logins);
  return db.select<OwnershipCell[]>(
    `SELECT MIN(cw.login) AS login, cw.repo_id, r.full_name,
            SUM(cw.commits)   AS commits,
            SUM(cw.additions) AS additions,
            SUM(cw.deletions) AS deletions
     FROM contributor_weeks cw
     JOIN repos r ON r.id = cw.repo_id
     WHERE cw.week >= ${from} AND cw.week <= ${to} AND cw.repo_id IN ${ids}${loginClause}
     GROUP BY LOWER(cw.login), cw.repo_id, r.full_name
     HAVING commits > 0
     ORDER BY commits DESC`,
    p.values,
  );
}

/**
 * Org roster: first seen, last seen, and repositories left cold.
 *
 * `left_repos` is repositories whose most recent commit week is this person
 * alone — they were the last (and only) committer in that week. That is the
 * "who went quiet and took a repo with them" signal, not a count of every
 * repository they ever touched. The last-week comparison is against every
 * committer, even when a contributor filter narrows the rows.
 */
export interface RosterRow {
  login: string;
  avatar_url: string | null;
  first_week: number;
  last_week: number;
  commits: number;
  commits_all: number;
  repos: number;
  repos_all: number;
  left_repos: number;
}

export async function rosterRows(
  db: Database,
  repoIds: readonly number[],
  fromWeek: number,
  toWeek: number,
  logins: Logins = null,
): Promise<RosterRow[]> {
  if (repoIds.length === 0) return [];
  const p = new Params();
  const from = p.add(fromWeek);
  const to = p.add(toWeek);
  const ids = p.in(repoIds);
  const loginClause = p.loginFilter("login", logins);
  const ids2 = p.in(repoIds);
  const loginClause2 = p.loginFilter("login", logins);
  const ids3 = p.in(repoIds);
  const ids4 = p.in(repoIds);
  return db.select<RosterRow[]>(
    `WITH bounds AS (
       SELECT LOWER(login) AS key,
              MIN(login)   AS login,
              MIN(week)    AS first_week,
              MAX(week)    AS last_week,
              SUM(commits) AS commits_all,
              SUM(CASE WHEN week >= ${from} AND week <= ${to} THEN commits ELSE 0 END) AS commits,
              COUNT(DISTINCT repo_id) AS repos_all,
              COUNT(DISTINCT CASE WHEN week >= ${from} AND week <= ${to} THEN repo_id END) AS repos
       FROM contributor_weeks
       WHERE commits > 0 AND repo_id IN ${ids}${loginClause}
       GROUP BY LOWER(login)
     ),
     person_repo_last AS (
       SELECT LOWER(login) AS key, repo_id, MAX(week) AS last_week
       FROM contributor_weeks
       WHERE commits > 0 AND repo_id IN ${ids2}${loginClause2}
       GROUP BY LOWER(login), repo_id
     ),
     repo_last AS (
       SELECT repo_id, MAX(week) AS last_week
       FROM contributor_weeks
       WHERE commits > 0 AND repo_id IN ${ids3}
       GROUP BY repo_id
     ),
     sole AS (
       SELECT pr.key, COUNT(*) AS left_repos
       FROM person_repo_last pr
       JOIN repo_last rl ON rl.repo_id = pr.repo_id AND rl.last_week = pr.last_week
       WHERE NOT EXISTS (
         SELECT 1 FROM contributor_weeks cw
         WHERE cw.repo_id = pr.repo_id
           AND cw.week = pr.last_week
           AND cw.commits > 0
           AND LOWER(cw.login) <> pr.key
           AND cw.repo_id IN ${ids4}
       )
       GROUP BY pr.key
     )
     SELECT b.login,
            (SELECT c.avatar_url FROM contributors c WHERE LOWER(c.login) = b.key LIMIT 1) AS avatar_url,
            b.first_week, b.last_week, b.commits, b.commits_all, b.repos, b.repos_all,
            COALESCE(s.left_repos, 0) AS left_repos
     FROM bounds b
     LEFT JOIN sole s ON s.key = b.key
     ORDER BY b.last_week ASC, b.login`,
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

/** Merged pull requests with size and cycle time, for the Pulse scatter. */
export interface MergedPrPoint {
  full_name: string;
  number: number;
  author: string | null;
  title: string | null;
  additions: number;
  deletions: number;
  comments: number;
  reviews: number;
  hours: number;
}

export async function mergedPrScatter(
  db: Database,
  repoIds: readonly number[],
  fromIso: string,
  toIso: string,
  logins: Logins = null,
): Promise<MergedPrPoint[]> {
  const p = new Params();
  const f = p.add(fromIso);
  const t = p.add(toIso);
  const ids = p.in(repoIds);
  const author = p.loginFilter("pr.author", logins);
  return db.select<MergedPrPoint[]>(
    `SELECT r.full_name, pr.number, pr.author, pr.title,
            pr.additions, pr.deletions, pr.comments, pr.reviews,
            (julianday(pr.merged_at) - julianday(pr.created_at)) * 24.0 AS hours
     FROM pull_requests pr
     JOIN repos r ON r.id = pr.repo_id
     WHERE pr.merged_at >= ${f} AND pr.merged_at <= ${t} AND pr.repo_id IN ${ids}${author}
       AND pr.created_at IS NOT NULL`,
    p.values,
  );
}

/** Pull requests still open in the cache, with age measured to `asOfIso`. */
export interface OpenPrRow {
  full_name: string;
  number: number;
  author: string | null;
  title: string | null;
  created_at: string;
  additions: number;
  deletions: number;
  comments: number;
  reviews: number;
  age_hours: number;
}

/**
 * Currently open pull requests in the selected repositories.
 *
 * The cache stores present state, not a historical snapshot, so this is "still
 * open as of the last sync" rather than "open at the end of the period". Age
 * is measured to `asOfIso` so tests (and a period end) can pin the clock.
 */
export async function openPullRequests(
  db: Database,
  repoIds: readonly number[],
  asOfIso: string,
  logins: Logins = null,
): Promise<OpenPrRow[]> {
  if (repoIds.length === 0) return [];
  const p = new Params();
  const asOf = p.add(asOfIso);
  const asOfCreated = p.add(asOfIso);
  const ids = p.in(repoIds);
  const author = p.loginFilter("pr.author", logins);
  return db.select<OpenPrRow[]>(
    `SELECT r.full_name, pr.number, pr.author, pr.title, pr.created_at,
            pr.additions, pr.deletions, pr.comments, pr.reviews,
            (julianday(${asOf}) - julianday(pr.created_at)) * 24.0 AS age_hours
     FROM pull_requests pr
     JOIN repos r ON r.id = pr.repo_id
     WHERE pr.state = 'OPEN'
       AND pr.created_at IS NOT NULL
       AND pr.created_at <= ${asOfCreated}
       AND pr.repo_id IN ${ids}${author}
     ORDER BY age_hours DESC`,
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

/**
 * Referrer counts by snapshot day — the history GitHub discards after 14 days.
 *
 * Each sync writes one snapshot per repository, so this is a series of sync
 * days rather than a true daily series. Still the only way to see share shift
 * over months.
 */
export async function trafficReferrersOverTime(
  db: Database,
  repoIds: readonly number[],
  fromDay: string,
  toDay: string,
): Promise<Array<{ day: string; referrer: string; count: number }>> {
  const p = new Params();
  const f = p.add(fromDay);
  const t = p.add(toDay);
  const ids = p.in(repoIds);
  return db.select(
    `SELECT snapshot_day AS day, referrer, SUM(count) AS count
     FROM traffic_referrers
     WHERE snapshot_day >= ${f} AND snapshot_day <= ${t} AND repo_id IN ${ids}
     GROUP BY snapshot_day, referrer
     ORDER BY snapshot_day, count DESC`,
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

export interface DependabotAlertRow {
  repo_id: number;
  full_name: string;
  number: number;
  severity: string | null;
  ecosystem: string | null;
  package: string | null;
  ghsa_id: string | null;
  summary: string | null;
  state: string | null;
  created_at: string | null;
  /** 1 when the same package is pinned to more than one version in-scope. */
  drifting: number;
}

/**
 * Open Dependabot alerts in the selected repositories, joined to SBOM drift
 * so a vulnerable package that is also version-split across the org is visible.
 */
export async function dependabotAlertRows(
  db: Database,
  repoIds: readonly number[],
): Promise<DependabotAlertRow[]> {
  const p = new Params();
  const ids = p.in(repoIds);
  const ids2 = p.in(repoIds);
  return db.select<DependabotAlertRow[]>(
    `SELECT a.repo_id, r.full_name, a.number, a.severity, a.ecosystem, a.package,
            a.ghsa_id, a.summary, a.state, a.created_at,
            CASE WHEN d.versions > 1 THEN 1 ELSE 0 END AS drifting
     FROM dependabot_alerts a
     JOIN repos r ON r.id = a.repo_id
     LEFT JOIN (
       SELECT ecosystem, package, COUNT(DISTINCT version) AS versions
       FROM dependencies
       WHERE repo_id IN ${ids2} AND version IS NOT NULL
       GROUP BY ecosystem, package
     ) d ON d.ecosystem = a.ecosystem AND d.package = a.package
     WHERE a.repo_id IN ${ids} AND (a.state IS NULL OR a.state = 'open')
     ORDER BY CASE LOWER(COALESCE(a.severity, ''))
                WHEN 'critical' THEN 0
                WHEN 'high' THEN 1
                WHEN 'medium' THEN 2
                WHEN 'low' THEN 3
                ELSE 4
              END,
              a.created_at DESC`,
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
  /** Interrupted work or statistics GitHub was still computing. */
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

export interface SyncProblem {
  /** Needed to retry this exact pair rather than the whole organisation. */
  repo_id: number;
  full_name: string;
  endpoint: string;
  status: string;
  error: string | null;
  attempts: number;
  last_attempt_at: string | null;
}

export async function syncProblems(db: Database): Promise<SyncProblem[]> {
  return db.select<SyncProblem[]>(
    `SELECT s.repo_id, r.full_name, s.endpoint, s.status, s.error,
            s.attempts, s.last_attempt_at
     FROM sync_state s
     JOIN repos r ON r.id = s.repo_id
     WHERE s.status IN ('pending', 'error')
     ORDER BY s.status, s.endpoint, r.full_name`,
  );
}
