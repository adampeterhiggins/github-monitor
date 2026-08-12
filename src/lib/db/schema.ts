/**
 * SQLite schema.
 *
 * Everything GitHub hands us is cached locally for three reasons:
 *  1. the `stats/*` endpoints are slow and 202-gated, so re-fetching per page view
 *     would make the app unusable;
 *  2. aggregating an org means touching ~80 repos, which is far too many round
 *     trips to do interactively;
 *  3. traffic data expires from GitHub after 14 days — persisting it is the only
 *     way to build history beyond that window.
 *
 * Weekly rows where every measure is zero are dropped on write; GitHub pads its
 * series with empty weeks and keeping them would multiply row counts for nothing.
 */

export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS repos (
  id             INTEGER PRIMARY KEY,
  owner          TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  full_name      TEXT    NOT NULL,
  private        INTEGER NOT NULL DEFAULT 0,
  fork           INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT,
  language       TEXT,
  size_kb        INTEGER NOT NULL DEFAULT 0,
  stars          INTEGER NOT NULL DEFAULT 0,
  forks          INTEGER NOT NULL DEFAULT 0,
  open_issues    INTEGER NOT NULL DEFAULT 0,
  can_push       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT,
  pushed_at      TEXT,
  html_url       TEXT,
  description    TEXT,
  UNIQUE (owner, name)
);
CREATE INDEX IF NOT EXISTS idx_repos_owner ON repos (owner);
CREATE INDEX IF NOT EXISTS idx_repos_pushed ON repos (pushed_at);

-- Which repos the user has selected. Kept separate from \`repos\` so a re-sync
-- of org metadata never clobbers the selection.
CREATE TABLE IF NOT EXISTS repo_selection (
  repo_id  INTEGER PRIMARY KEY REFERENCES repos (id) ON DELETE CASCADE,
  included INTEGER NOT NULL DEFAULT 1
);

-- Per-repo, per-endpoint ingestion bookkeeping. Drives resumability: a repo whose
-- stats endpoint was still computing when the sweep ended is retried next time.
CREATE TABLE IF NOT EXISTS sync_state (
  repo_id         INTEGER NOT NULL,
  endpoint        TEXT    NOT NULL,
  status          TEXT    NOT NULL,           -- ok | pending | error | forbidden | empty
  etag            TEXT,
  last_ok_at      TEXT,
  last_attempt_at TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  PRIMARY KEY (repo_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_state (endpoint, status);

-- Answers "which repositories has this person committed to" without needing a
-- sync. Populated by probing /commits?author=, one request per repository, so it
-- works from a cold cache -- which the sync-derived tables below cannot do, and
-- which is exactly when you need it to choose what to sync.
CREATE TABLE IF NOT EXISTS author_repo_probe (
  login      TEXT    NOT NULL,
  repo_id    INTEGER NOT NULL,
  commits    INTEGER NOT NULL DEFAULT 0,
  -- NULL when the repository could not be read at all, distinct from zero commits.
  readable   INTEGER NOT NULL DEFAULT 1,
  checked_at TEXT,
  PRIMARY KEY (login, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_probe_login ON author_repo_probe (login);

-- Named selections of repositories or contributors.
--
-- Kept in SQLite rather than the settings store because a repository selection is
-- a list of ids that only mean anything alongside the repos table, and because
-- these are user-authored content: clearAnalytics deliberately leaves this table
-- alone, so wiping the cache never loses a saved selection.
CREATE TABLE IF NOT EXISTS saved_filters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,          -- repos | contributors
  name       TEXT NOT NULL,
  -- JSON array: repo ids for 'repos', logins for 'contributors'.
  payload    TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  -- One name per kind, so saving over an existing name updates it rather than
  -- quietly creating a second entry that looks identical in the list.
  UNIQUE (kind, name)
);
CREATE INDEX IF NOT EXISTS idx_saved_kind ON saved_filters (kind);

CREATE TABLE IF NOT EXISTS contributors (
  login      TEXT PRIMARY KEY,
  gh_id      INTEGER,
  avatar_url TEXT,
  html_url   TEXT,
  type       TEXT
);

-- The spine of the Contributors page. One row per repo/author/week with any activity.
CREATE TABLE IF NOT EXISTS contributor_weeks (
  repo_id   INTEGER NOT NULL,
  login     TEXT    NOT NULL,
  week      INTEGER NOT NULL,                 -- Unix seconds, Sunday 00:00 UTC
  commits   INTEGER NOT NULL DEFAULT 0,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, login, week)
);
CREATE INDEX IF NOT EXISTS idx_cw_week ON contributor_weeks (week);
CREATE INDEX IF NOT EXISTS idx_cw_login ON contributor_weeks (login);
CREATE INDEX IF NOT EXISTS idx_cw_repo_week ON contributor_weeks (repo_id, week);

CREATE TABLE IF NOT EXISTS commit_activity (
  repo_id INTEGER NOT NULL,
  week    INTEGER NOT NULL,
  dow     INTEGER NOT NULL,                   -- 0 = Sunday
  commits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, week, dow)
);
CREATE INDEX IF NOT EXISTS idx_ca_week ON commit_activity (week);

CREATE TABLE IF NOT EXISTS participation (
  repo_id       INTEGER NOT NULL,
  week          INTEGER NOT NULL,
  all_commits   INTEGER NOT NULL DEFAULT 0,
  owner_commits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, week)
);

CREATE TABLE IF NOT EXISTS code_frequency (
  repo_id   INTEGER NOT NULL,
  week      INTEGER NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,       -- stored positive; sign applied at render
  PRIMARY KEY (repo_id, week)
);
CREATE INDEX IF NOT EXISTS idx_cf_week ON code_frequency (week);

CREATE TABLE IF NOT EXISTS punchcard (
  repo_id INTEGER NOT NULL,
  dow     INTEGER NOT NULL,
  hour    INTEGER NOT NULL,
  commits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, dow, hour)
);

-- Accumulates beyond GitHub's 14-day retention: rows are upserted, never truncated.
CREATE TABLE IF NOT EXISTS traffic_daily (
  repo_id INTEGER NOT NULL,
  kind    TEXT    NOT NULL,                   -- view | clone
  day     TEXT    NOT NULL,                   -- YYYY-MM-DD
  count   INTEGER NOT NULL DEFAULT 0,
  uniques INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, kind, day)
);
CREATE INDEX IF NOT EXISTS idx_traffic_day ON traffic_daily (day);

CREATE TABLE IF NOT EXISTS traffic_paths (
  repo_id      INTEGER NOT NULL,
  snapshot_day TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  title        TEXT,
  count        INTEGER NOT NULL DEFAULT 0,
  uniques      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, snapshot_day, path)
);

CREATE TABLE IF NOT EXISTS traffic_referrers (
  repo_id      INTEGER NOT NULL,
  snapshot_day TEXT    NOT NULL,
  referrer     TEXT    NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  uniques      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, snapshot_day, referrer)
);

CREATE TABLE IF NOT EXISTS community (
  repo_id        INTEGER PRIMARY KEY,
  health         INTEGER NOT NULL DEFAULT 0,
  has_readme     INTEGER NOT NULL DEFAULT 0,
  has_license    INTEGER NOT NULL DEFAULT 0,
  has_coc        INTEGER NOT NULL DEFAULT 0,
  has_contrib    INTEGER NOT NULL DEFAULT 0,
  has_issue_tpl  INTEGER NOT NULL DEFAULT 0,
  has_pr_tpl     INTEGER NOT NULL DEFAULT 0,
  has_security   INTEGER NOT NULL DEFAULT 0,
  has_desc       INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT
);

CREATE TABLE IF NOT EXISTS forks (
  repo_id      INTEGER NOT NULL,
  fork_id      INTEGER NOT NULL,
  full_name    TEXT    NOT NULL,
  owner_login  TEXT,
  html_url     TEXT,
  created_at   TEXT,
  pushed_at    TEXT,
  stars        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, fork_id)
);

CREATE TABLE IF NOT EXISTS branches (
  repo_id   INTEGER NOT NULL,
  name      TEXT    NOT NULL,
  protected INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, name)
);

CREATE TABLE IF NOT EXISTS dependencies (
  repo_id   INTEGER NOT NULL,
  ecosystem TEXT    NOT NULL,
  package   TEXT    NOT NULL,
  version   TEXT,
  PRIMARY KEY (repo_id, ecosystem, package)
);
CREATE INDEX IF NOT EXISTS idx_deps_pkg ON dependencies (ecosystem, package);

CREATE TABLE IF NOT EXISTS dependabot_alerts (
  repo_id      INTEGER NOT NULL,
  number       INTEGER NOT NULL,
  severity     TEXT,
  ecosystem    TEXT,
  package      TEXT,
  ghsa_id      TEXT,
  summary      TEXT,
  state        TEXT,
  created_at   TEXT,
  PRIMARY KEY (repo_id, number)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  repo_id     INTEGER NOT NULL,
  run_id      INTEGER NOT NULL,
  workflow_id INTEGER,
  name        TEXT,
  event       TEXT,
  status      TEXT,
  conclusion  TEXT,
  created_at  TEXT,
  started_at  TEXT,
  updated_at  TEXT,
  duration_ms INTEGER,
  PRIMARY KEY (repo_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_runs_created ON workflow_runs (created_at);
CREATE INDEX IF NOT EXISTS idx_runs_repo_created ON workflow_runs (repo_id, created_at);

-- Backs Pulse, which has no dedicated GitHub endpoint and must be derived.
CREATE TABLE IF NOT EXISTS pull_requests (
  repo_id    INTEGER NOT NULL,
  number     INTEGER NOT NULL,
  author     TEXT,
  title      TEXT,
  state      TEXT,                            -- OPEN | CLOSED | MERGED
  created_at TEXT,
  merged_at  TEXT,
  closed_at  TEXT,
  additions  INTEGER NOT NULL DEFAULT 0,
  deletions  INTEGER NOT NULL DEFAULT 0,
  comments   INTEGER NOT NULL DEFAULT 0,
  reviews    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, number)
);
CREATE INDEX IF NOT EXISTS idx_pr_created ON pull_requests (created_at);
CREATE INDEX IF NOT EXISTS idx_pr_merged ON pull_requests (merged_at);

CREATE TABLE IF NOT EXISTS issues (
  repo_id    INTEGER NOT NULL,
  number     INTEGER NOT NULL,
  author     TEXT,
  title      TEXT,
  state      TEXT,                            -- OPEN | CLOSED
  created_at TEXT,
  closed_at  TEXT,
  comments   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, number)
);
CREATE INDEX IF NOT EXISTS idx_issue_created ON issues (created_at);
CREATE INDEX IF NOT EXISTS idx_issue_closed ON issues (closed_at);
`;
