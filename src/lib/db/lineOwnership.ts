import type Database from "@tauri-apps/plugin-sql";
import type { GithubAccount, OwnershipHistoryAuthor, OwnershipHistoryPoint, OwnershipReport } from "../lineOwnership";
import { buildAccountIndex, normalizeEmail, normalizeName, type ManualMapping, type OwnershipAccountIndex } from "../ownershipIdentity";
import { legacyHistory, type RawHistoryIdentity, type RepoHistoryData } from "../ownershipHistory";
import { Params } from "./params";
import { bulkInsert, withWriteLock } from ".";

type Db = Pick<Database, "select" | "execute">;

/* ── HEAD snapshot ────────────────────────────────────────────────────────── */

export interface OwnershipSnapshotRow {
  repo_id: number;
  full_name: string;
  revision: string | null;
  calculated_at: string | null;
  checked_at: string | null;
  status: string | null;
  error: string | null;
  report: OwnershipReport | null;
}

/** What Rust needs to continue the HEAD scan: a native cache file, or a legacy full snapshot to convert once. */
export interface OwnershipCheckpoint {
  cacheRef: string | null;
  legacyJson: string | null;
}

export async function ownershipCheckpoint(db: Db, repoId: number): Promise<OwnershipCheckpoint | null> {
  const rows = await db.select<Array<{ cache_ref: string | null; snapshot: string | null }>>(
    `SELECT cache_ref, CASE WHEN cache_ref IS NULL AND length(snapshot) > 0 THEN snapshot END AS snapshot
     FROM line_ownership WHERE repo_id = $1`, [repoId],
  );
  const row = rows[0];
  if (!row) return null;
  return { cacheRef: row.cache_ref ?? null, legacyJson: row.cache_ref ? null : row.snapshot ?? null };
}

// Legacy rows keep their validity fields inside the snapshot. Extracting them
// never transfers file caches through the WebView; invalid snapshots rebuild.
const LEGACY_METADATA = `CASE WHEN length(snapshot) > 0 AND json_valid(snapshot) THEN CASE WHEN
  json_type(snapshot, '$.files') = 'object' AND json_type(snapshot, '$.coauthors') = 'object'
  AND json_type(snapshot, '$.report.credits') = 'array' THEN json_object(
  'version', json_extract(snapshot, '$.version'),
  'revision', json_extract(snapshot, '$.report.revision'),
  'options', json_extract(snapshot, '$.report.options')) ELSE NULL END ELSE NULL END`;
const METADATA = `CASE WHEN cache_ref IS NOT NULL THEN metadata ELSE ${LEGACY_METADATA} END`;

export async function ownershipMetadata(db: Db, repoId: number): Promise<string | null> {
  const rows = await db.select<Array<{ metadata: string | null }>>(
    `SELECT ${METADATA} AS metadata FROM line_ownership WHERE repo_id = $1`, [repoId],
  );
  return rows[0]?.metadata ?? null;
}

/** Compare-and-update prevents a concurrent reset/write from being mistaken for
 * the snapshot whose remote SHA we checked. Only checked_at changes. */
export async function touchOwnershipSnapshot(db: Db, repoId: number, metadata: string): Promise<boolean> {
  return withWriteLock(async () => {
    const result = await db.execute(
      `UPDATE line_ownership SET checked_at = $1 WHERE repo_id = $2 AND (${METADATA}) = $3`,
      [new Date().toISOString(), repoId, metadata],
    );
    return result.rowsAffected === 1;
  });
}

/** What `sync_line_ownership` returns: the small report and the name of its native file cache. */
export interface OwnershipScan {
  report: string;
  metadata: string;
  cacheRef: string;
}

/** Report, metadata and cache reference are replaced by ONE statement. A failed
 * or cancelled scan leaves the previous successful row, and its cache file, intact. */
export async function writeOwnershipSnapshot(db: Db, repoId: number, scan: OwnershipScan, full: boolean): Promise<void> {
  const report = JSON.parse(scan.report) as OwnershipReport;
  const version = (JSON.parse(scan.metadata) as { version?: number }).version ?? null;
  const now = new Date().toISOString();
  await withWriteLock(() => db.execute(
    `INSERT INTO line_ownership (repo_id, revision, calculated_at, checked_at, snapshot, report, metadata, cache_ref)
     VALUES ($1, $2, $3, $3, '', $4, $5, $6)
     ON CONFLICT (repo_id) DO UPDATE SET
       calculated_at = CASE WHEN line_ownership.revision IS excluded.revision AND $7 = 0 AND $8 = 0
         AND COALESCE(json_extract(line_ownership.metadata, '$.version'),
           CASE WHEN json_valid(line_ownership.snapshot) THEN json_extract(line_ownership.snapshot, '$.version') END) = $9
         THEN line_ownership.calculated_at ELSE excluded.calculated_at END,
       revision = excluded.revision, checked_at = excluded.checked_at, snapshot = '',
       report = excluded.report, metadata = excluded.metadata, cache_ref = excluded.cache_ref`,
    [repoId, report.revision || null, now, scan.report, scan.metadata, scan.cacheRef, full ? 1 : 0, report.filesRecalculated, version],
  ).then(() => {}));
}

const REPORT = `COALESCE(o.report, CASE WHEN length(o.snapshot) > 0 AND json_valid(o.snapshot) THEN json_extract(o.snapshot, '$.report') END)`;

export async function ownershipSnapshots(db: Db, repoIds: number[]): Promise<OwnershipSnapshotRow[]> {
  if (!repoIds.length) return [];
  const p = new Params();
  const rows = await db.select<Array<Omit<OwnershipSnapshotRow, "report"> & { report_json: string | null }>>(
    `SELECT r.id AS repo_id, r.full_name, o.revision, o.calculated_at, o.checked_at,
       s.status, s.error, ${REPORT} AS report_json
     FROM repos r LEFT JOIN line_ownership o ON o.repo_id = r.id
     LEFT JOIN sync_state s ON s.repo_id = r.id AND s.endpoint = 'line_ownership'
     WHERE r.id IN ${p.in(repoIds)} ORDER BY r.full_name`, p.values,
  );
  return rows.map(({ report_json, ...row }) => ({ ...row, report: report_json ? JSON.parse(report_json) as OwnershipReport : null }));
}

export async function ownershipReport(db: Db, repoId: number): Promise<OwnershipReport | null> {
  const rows = await db.select<Array<{ report_json: string | null }>>(
    `SELECT ${REPORT} AS report_json FROM line_ownership o WHERE o.repo_id = $1`, [repoId],
  );
  const json = rows[0]?.report_json;
  return json ? JSON.parse(json) as OwnershipReport : null;
}

/** Which history a repository shows: a generation, the legacy rows, or nothing yet. */
export type HistorySource = { kind: "generation"; generation: number; partial: boolean } | { kind: "legacy" } | { kind: "none" };

/** Cheap per-repository status and revisions. Query keys for the heavy reads include these. */
export interface OwnershipRevision {
  repoId: number;
  fullName: string;
  revision: string | null;
  calculatedAt: string | null;
  checkedAt: string | null;
  status: string | null;
  error: string | null;
  hasReport: boolean;
  /** Changes whenever the saved report changes. */
  reportRevision: string;
  history: HistorySource;
  /** Changes whenever the shown history changes. */
  historyRevision: string;
  historyStatus: string | null;
  historyError: string | null;
}

export async function ownershipRevisions(db: Db, repoIds: readonly number[]): Promise<OwnershipRevision[]> {
  if (!repoIds.length) return [];
  const p = new Params();
  const rows = await db.select<Array<{
    repo_id: number; full_name: string; revision: string | null; calculated_at: string | null; checked_at: string | null;
    status: string | null; error: string | null; has_report: number | null; cache_ref: string | null;
    visible_generation: number | null; building_generation: number | null; history_status: string | null;
    history_revision: number | null; history_error: string | null; has_legacy: number | null;
  }>>(
    `SELECT r.id AS repo_id, r.full_name, o.revision, o.calculated_at, o.checked_at, s.status, s.error,
       CASE WHEN o.repo_id IS NULL THEN 0 WHEN o.report IS NOT NULL OR length(o.snapshot) > 0 THEN 1 ELSE 0 END AS has_report,
       o.cache_ref, g.visible_generation, g.building_generation, g.status AS history_status,
       g.revision AS history_revision, g.error AS history_error,
       EXISTS (SELECT 1 FROM line_ownership_history h WHERE h.repo_id = r.id) AS has_legacy
     FROM repos r LEFT JOIN line_ownership o ON o.repo_id = r.id
     LEFT JOIN sync_state s ON s.repo_id = r.id AND s.endpoint = 'line_ownership'
     LEFT JOIN line_ownership_history_gen g ON g.repo_id = r.id
     WHERE r.id IN ${p.in(repoIds)} ORDER BY r.full_name`, p.values,
  );
  return rows.map((row) => {
    let history: HistorySource;
    if (row.visible_generation != null) {
      history = { kind: "generation", generation: row.visible_generation,
        partial: row.visible_generation === row.building_generation && row.history_status !== "done" };
    } else if (row.has_legacy) history = { kind: "legacy" };
    else if (row.building_generation != null) history = { kind: "generation", generation: row.building_generation, partial: row.history_status !== "done" };
    else history = { kind: "none" };
    return {
      repoId: row.repo_id,
      fullName: row.full_name,
      revision: row.revision,
      calculatedAt: row.calculated_at,
      checkedAt: row.checked_at,
      status: row.status,
      error: row.error,
      hasReport: Boolean(row.has_report),
      reportRevision: `${row.calculated_at ?? ""}:${row.cache_ref ?? ""}:${row.revision ?? ""}`,
      history,
      // Only the shown rows matter: a rebuild into another generation does not change them.
      historyRevision: history.kind === "generation"
        ? history.generation === row.building_generation ? `g${history.generation}:${row.history_revision ?? 0}` : `g${history.generation}`
        : history.kind,
      historyStatus: row.history_status,
      historyError: row.history_error,
    };
  });
}

/* ── History generations ──────────────────────────────────────────────────── */

export const HISTORY_FORMAT = 2;

export interface HistoryGenState {
  visibleGeneration: number | null;
  buildingGeneration: number;
  target: string | null;
  cursor: string | null;
  checkpointRef: string | null;
  engine: string;
  format: number;
  status: "building" | "done" | "failed";
  revision: number;
  error: string | null;
}

export async function historyGenState(db: Db, repoId: number): Promise<HistoryGenState | null> {
  const rows = await db.select<Array<{
    visible_generation: number | null; building_generation: number; target: string | null; cursor: string | null;
    checkpoint_ref: string | null; engine: string; format: number; status: HistoryGenState["status"]; revision: number; error: string | null;
  }>>("SELECT * FROM line_ownership_history_gen WHERE repo_id = $1", [repoId]);
  const row = rows[0];
  return row ? {
    visibleGeneration: row.visible_generation, buildingGeneration: row.building_generation, target: row.target,
    cursor: row.cursor, checkpointRef: row.checkpoint_ref, engine: row.engine, format: row.format,
    status: row.status, revision: row.revision, error: row.error,
  } : null;
}

/** True when the visible history already ends at this default-branch commit. */
export async function ownershipHistoryCovers(db: Db, repoId: number, revision: string): Promise<boolean> {
  const state = await historyGenState(db, repoId);
  return state != null && state.status === "done" && state.format === HISTORY_FORMAT
    && state.visibleGeneration === state.buildingGeneration && state.target === revision;
}

/** Start a new generation. The visible one, or legacy rows, stay on screen until it completes. */
export async function beginHistoryGeneration(db: Db, repoId: number, engine: string): Promise<number> {
  return withWriteLock(async () => {
    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO line_ownership_history_gen (repo_id, visible_generation, building_generation, engine, format, status, revision, updated_at)
       VALUES ($1, NULL, 1, $2, $3, 'building', 1, $4)
       ON CONFLICT (repo_id) DO UPDATE SET
         building_generation = MAX(COALESCE(visible_generation, 0), building_generation) + 1,
         target = NULL, cursor = NULL, checkpoint_ref = NULL, engine = excluded.engine, format = excluded.format,
         status = 'building', error = NULL, revision = line_ownership_history_gen.revision + 1, updated_at = excluded.updated_at`,
      [repoId, engine, HISTORY_FORMAT, now],
    );
    const rows = await db.select<Array<{ building_generation: number }>>(
      "SELECT building_generation FROM line_ownership_history_gen WHERE repo_id = $1", [repoId],
    );
    return rows[0].building_generation;
  });
}

/** Extend the visible generation in place, e.g. after new commits on the default branch. */
export async function reopenHistoryGeneration(db: Db, repoId: number, generation: number): Promise<boolean> {
  return withWriteLock(async () => {
    const result = await db.execute(
      `UPDATE line_ownership_history_gen SET status = 'building', error = NULL, revision = revision + 1, updated_at = $3
       WHERE repo_id = $1 AND building_generation = $2`,
      [repoId, generation, new Date().toISOString()],
    );
    return result.rowsAffected === 1;
  });
}

export interface HistoryPointV2 {
  revision: string;
  committedAt: string;
  totalLines: number;
  coauthoredLines: number;
  /** `[raw identity ids, lines]`, absolute levels at this commit. */
  groups: Array<[number[], number]>;
}

export interface HistoryBatchV2 {
  /** The checkpoint cannot continue this walk (rewritten branch, options, engine, format, mailmap). */
  needsReset: boolean;
  identities: Array<[number, string, string]>;
  points: HistoryPointV2[];
  cursor: string | null;
  checkpointRef: string | null;
  done: boolean;
  completed: number;
  total: number;
  /** When done: the raw attribution at the target, for verification against the HEAD scan. */
  final: { totalLines: number; groups: Array<[Array<[string, string]>, number]> } | null;
  engine: string;
  fallbacks?: Record<string, number>;
}

const dayOf = (committedAt: string) => {
  const unix = Math.floor(Date.parse(committedAt) / 1000);
  return { unix, day: new Date(unix * 1000).toISOString().slice(0, 10) };
};

/**
 * Durable handoff for one history batch. Identities and day rows are idempotent
 * (insert-or-ignore and a winner-only upsert), so a crash anywhere before the
 * final UPDATE simply repeats the batch from the previous checkpoint. That single
 * UPDATE advances the cursor and checkpoint reference, and on completion flips the
 * visible generation; SQLite makes it atomic on its own.
 */
export async function writeHistoryBatch(
  db: Db, repoId: number, generation: number, target: string, batch: HistoryBatchV2,
  completion: { verified: boolean; error?: string } | null = null,
): Promise<boolean> {
  return withWriteLock(async () => {
    await bulkInsert(db as Database, {
      table: "line_ownership_identity",
      columns: ["repo_id", "generation", "raw_id", "name", "email"],
      rows: batch.identities.map(([id, name, email]) => [repoId, generation, id, name, email]),
      onConflict: "ignore",
    });
    await upsertDays(db, repoId, generation, batch.points);
    const done = batch.done && completion != null;
    const status = !done ? "building" : completion!.verified ? "done" : "failed";
    const result = await db.execute(
      `UPDATE line_ownership_history_gen SET
         target = $3, cursor = $4, checkpoint_ref = $5, status = $6, error = $7,
         visible_generation = CASE WHEN $6 = 'done' THEN building_generation ELSE visible_generation END,
         revision = revision + 1, updated_at = $8
       WHERE repo_id = $1 AND building_generation = $2`,
      [repoId, generation, target, batch.cursor, batch.checkpointRef, status, completion?.error ?? null, new Date().toISOString()],
    );
    if (result.rowsAffected !== 1) return false;
    if (status === "done") await collectHistoryGenerations(db, repoId);
    return true;
  });
}

/** Upsert day rows, keeping the winner by the saved-history rule: latest committer second, then greater SHA. */
async function upsertDays(db: Db, repoId: number, generation: number, points: readonly HistoryPointV2[]): Promise<void> {
  const perRow = 9;
  const rowsPerBatch = Math.floor(900 / perRow);
  for (let i = 0; i < points.length; i += rowsPerBatch) {
    const params: unknown[] = [];
    const tuples = points.slice(i, i + rowsPerBatch).map((point) => {
      const { unix, day } = dayOf(point.committedAt);
      const values = [repoId, generation, day, point.revision, point.committedAt, unix, point.totalLines, point.coauthoredLines, JSON.stringify(point.groups)];
      return `(${values.map((v) => { params.push(v); return `$${params.length}`; }).join(", ")})`;
    });
    await db.execute(
      `INSERT INTO line_ownership_day (repo_id, generation, day, revision, committed_at, committed_unix, total_lines, coauthored_lines, groups_json)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (repo_id, generation, day) DO UPDATE SET
         revision = excluded.revision, committed_at = excluded.committed_at, committed_unix = excluded.committed_unix,
         total_lines = excluded.total_lines, coauthored_lines = excluded.coauthored_lines, groups_json = excluded.groups_json
       WHERE excluded.committed_unix > line_ownership_day.committed_unix
          OR (excluded.committed_unix = line_ownership_day.committed_unix AND excluded.revision > line_ownership_day.revision)`,
      params,
    );
  }
}

/** Drop generations nobody shows or builds, and legacy rows once a generation is visible. Idempotent. */
async function collectHistoryGenerations(db: Db, repoId: number): Promise<void> {
  const keep = `SELECT visible_generation FROM line_ownership_history_gen WHERE repo_id = $1
    UNION SELECT building_generation FROM line_ownership_history_gen WHERE repo_id = $1`;
  await db.execute(`DELETE FROM line_ownership_day WHERE repo_id = $1 AND generation NOT IN (${keep})`, [repoId]);
  await db.execute(`DELETE FROM line_ownership_identity WHERE repo_id = $1 AND generation NOT IN (${keep})`, [repoId]);
  await db.execute(
    `DELETE FROM line_ownership_history WHERE repo_id = $1
       AND EXISTS (SELECT 1 FROM line_ownership_history_gen WHERE repo_id = $1 AND visible_generation IS NOT NULL)`, [repoId]);
  await db.execute(
    `DELETE FROM line_ownership_history_state WHERE repo_id = $1
       AND EXISTS (SELECT 1 FROM line_ownership_history_gen WHERE repo_id = $1 AND visible_generation IS NOT NULL)`, [repoId]);
}

/** Record a failed generation without touching what is visible. */
export async function failHistoryGeneration(db: Db, repoId: number, generation: number, error: string): Promise<void> {
  await withWriteLock(() => db.execute(
    `UPDATE line_ownership_history_gen SET status = 'failed', error = $3, revision = revision + 1, updated_at = $4
     WHERE repo_id = $1 AND building_generation = $2`,
    [repoId, generation, error, new Date().toISOString()],
  ).then(() => {}));
}

/** One repository's shown history, compact: identities once, then one row per UTC day. */
export async function ownershipDays(db: Db, repoId: number, source: HistorySource): Promise<RepoHistoryData> {
  if (source.kind === "legacy") return legacyHistory(repoId, await ownershipHistory(db, [repoId]));
  if (source.kind === "none") return { repoId, legacy: false, identities: new Map(), days: [] };
  const [identities, days] = await Promise.all([
    db.select<Array<{ raw_id: number; name: string; email: string }>>(
      "SELECT raw_id, name, email FROM line_ownership_identity WHERE repo_id = $1 AND generation = $2", [repoId, source.generation]),
    db.select<Array<{ revision: string; committed_at: string; groups_json: string }>>(
      "SELECT revision, committed_at, groups_json FROM line_ownership_day WHERE repo_id = $1 AND generation = $2 ORDER BY day",
      [repoId, source.generation]),
  ]);
  return {
    repoId,
    legacy: false,
    partial: source.partial,
    identities: new Map<number, RawHistoryIdentity>(identities.map((row) => [row.raw_id, { name: row.name, email: row.email }])),
    days: days.map((row) => ({ committedAt: row.committed_at, revision: row.revision, groups: JSON.parse(row.groups_json) })),
  };
}

/** Legacy rows: last saved point per repository per UTC day. */
export async function ownershipHistory(db: Db, repoIds: number[]): Promise<OwnershipHistoryPoint[]> {
  if (!repoIds.length) return [];
  const p = new Params();
  const rows = await db.select<Array<{ repo_id: number; committed_at: string; authors_json: string }>>(
    `SELECT repo_id, committed_at, authors_json FROM (
       SELECT repo_id, committed_at, authors_json,
         ROW_NUMBER() OVER (
           PARTITION BY repo_id, date(committed_at)
           ORDER BY datetime(committed_at) DESC, revision DESC
         ) AS rn
       FROM line_ownership_history
       WHERE repo_id IN ${p.in(repoIds)}
     ) WHERE rn = 1
     ORDER BY committed_at, repo_id`,
    p.values,
  );
  return rows.map((row) => ({
    repoId: row.repo_id,
    committedAt: row.committed_at,
    authors: JSON.parse(row.authors_json) as OwnershipHistoryAuthor[],
  }));
}

/* ── GitHub accounts ─────────────────────────────────────────────────────── */

/** Emails already resolved. A miss older than `retryMissesBefore` counts as unknown, so it is tried again. */
export async function knownGithubAccountEmails(db: Db, emails: readonly string[], retryMissesBefore?: string): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const p = new Params();
  const rows = await db.select<Array<{ email: string }>>(
    `SELECT email FROM github_accounts WHERE email IN ${p.in(emails)}
       AND (github_id IS NOT NULL OR ${retryMissesBefore ? `COALESCE(checked_at, '') >= ${p.add(retryMissesBefore)}` : "1"})`,
    p.values,
  );
  return new Set(rows.map((row) => row.email));
}

/** Accounts GitHub matched. Unmatched addresses stay out of the join. */
export async function githubAccounts(db: Db): Promise<Map<string, GithubAccount>> {
  const rows = await db.select<Array<{ email: string; login: string; github_id: string }>>(
    "SELECT email, login, github_id FROM github_accounts WHERE login IS NOT NULL AND github_id IS NOT NULL",
  );
  return new Map(rows.map((row) => [row.email, { login: row.login, id: row.github_id }]));
}

/** Remember lookups. A null login is a miss; every returned ID is also kept as evidence. */
export async function writeGithubAccounts(
  db: Db,
  rows: Array<[string, string | null, string | null]>,
): Promise<void> {
  const now = new Date().toISOString();
  const matched = rows.filter((row): row is [string, string, string] => row[1] != null && row[2] != null);
  await withWriteLock(async () => {
    await bulkInsert(db as Database, {
      table: "github_accounts",
      columns: ["email", "login", "github_id", "checked_at"],
      rows: rows.map(([email, login, id]) => [email, login, id, now]),
      conflictColumns: ["email"],
      onConflict: "replace",
    });
    await bulkInsert(db as Database, {
      table: "github_account_observations",
      columns: ["email", "github_id", "login", "observed_at"],
      rows: matched.map(([email, login, id]) => [email, id, login, now]),
      onConflict: "ignore",
    });
    await recordGithubUsers(db, matched.map(([, login, id]) => ({ id, login })), "commit");
  });
}

/** Add accounts to the registry. A commit match never overrides a login read back by ID. */
async function recordGithubUsers(db: Db, users: ReadonlyArray<{ id: string; login: string }>, source: "commit" | "lookup"): Promise<void> {
  if (!users.length) return;
  const now = new Date().toISOString();
  for (let i = 0; i < users.length; i += 200) {
    const slice = users.slice(i, i + 200);
    const p = new Params();
    const tuples = slice.map((u) => `(${p.add(u.id)}, ${p.add(u.login)}, ${p.add(source)}, ${p.add(source === "lookup" ? now : null)})`);
    await db.execute(
      `INSERT INTO github_users (github_id, login, source, checked_at) VALUES ${tuples.join(", ")}
       ON CONFLICT (github_id) DO UPDATE SET
         login = CASE WHEN excluded.source = 'lookup' OR github_users.source <> 'lookup' THEN excluded.login ELSE github_users.login END,
         source = CASE WHEN excluded.source = 'lookup' THEN 'lookup' ELSE github_users.source END,
         checked_at = COALESCE(excluded.checked_at, github_users.checked_at)`,
      p.values,
    );
  }
  await bulkInsert(db as Database, {
    table: "github_user_logins",
    columns: ["github_id", "login_lower", "login", "seen_at"],
    rows: users.map((u) => [u.id, u.login.toLowerCase(), u.login, now]),
    onConflict: "ignore",
  });
}

/** An account read back by its ID: the current login, authoritative for renames. */
export async function writeGithubUserLookup(db: Db, id: string, login: string): Promise<void> {
  await withWriteLock(() => recordGithubUsers(db, [{ id, login }], "lookup"));
}

/** Mark an ID as checked without a login, e.g. a deleted account. Its last known login stays. */
export async function markGithubUserChecked(db: Db, id: string): Promise<void> {
  await withWriteLock(() => db.execute("UPDATE github_users SET checked_at = $2 WHERE github_id = $1", [id, new Date().toISOString()]).then(() => {}));
}

/** Registry rows whose login has not been read back by ID recently, oldest first. */
export async function staleGithubUsers(db: Db, before: string, limit: number): Promise<string[]> {
  const rows = await db.select<Array<{ github_id: string }>>(
    `SELECT github_id FROM github_users WHERE checked_at IS NULL OR checked_at < $1
     ORDER BY COALESCE(checked_at, '') LIMIT $2`, [before, limit],
  );
  return rows.map((row) => row.github_id);
}

async function revisionKey(db: Db): Promise<string> {
  const rows = await db.select<Array<{ key: string; value: string }>>(
    "SELECT key, value FROM meta WHERE key IN ('ownership_account_revision', 'ownership_manual_map_revision')",
  );
  const value = (key: string) => rows.find((row) => row.key === key)?.value ?? "0";
  return `a${value("ownership_account_revision")}:m${value("ownership_manual_map_revision")}`;
}

/** The revision of everything account resolution reads. Cheap; key caches on it. */
export async function ownershipAccountRevision(db: Db): Promise<string> {
  return revisionKey(db);
}

/**
 * Everything account resolution needs. Current login precedence: a login read back
 * by ID, then the Contributors login with the latest activity, then the latest
 * commit match. Every login seen for an ID keeps selecting it after a rename.
 */
export async function ownershipAccountIndex(db: Db): Promise<OwnershipAccountIndex> {
  const [revision, accounts, observations, users, logins, contributors, manual] = await Promise.all([
    revisionKey(db),
    db.select<Array<{ email: string; login: string; github_id: string }>>(
      "SELECT email, login, github_id FROM github_accounts WHERE login IS NOT NULL AND github_id IS NOT NULL"),
    db.select<Array<{ email: string; github_id: string }>>("SELECT email, github_id FROM github_account_observations"),
    db.select<Array<{ github_id: string; login: string; source: string }>>("SELECT github_id, login, source FROM github_users"),
    db.select<Array<{ github_id: string; login: string }>>("SELECT github_id, login FROM github_user_logins"),
    db.select<Array<{ gh_id: number | string; login: string; last_week: number | null }>>(
      `SELECT c.gh_id, c.login, (SELECT MAX(w.week) FROM contributor_weeks w WHERE w.login = c.login) AS last_week
       FROM contributors c WHERE c.gh_id IS NOT NULL`),
    listManualMappings(db),
  ]);
  const byId = new Map<string, { login: string; rank: number; logins: Set<string> }>();
  const offer = (id: string, login: string, rank: number) => {
    const entry = byId.get(id) ?? { login, rank: -Infinity, logins: new Set<string>() };
    entry.logins.add(login);
    if (rank > entry.rank) {
      entry.login = login;
      entry.rank = rank;
    }
    byId.set(id, entry);
  };
  for (const u of users) offer(u.github_id, u.login, u.source === "lookup" ? 3e12 : 0);
  for (const c of contributors) offer(String(c.gh_id), c.login, 1e12 + (c.last_week ?? 0));
  for (const l of logins) offer(l.github_id, l.login, -1);
  return buildAccountIndex({
    revision,
    accounts: accounts.map((row) => [row.email, { login: row.login, id: row.github_id }] as const),
    observations: observations.map((row) => ({ email: row.email, id: row.github_id })),
    users: [...byId.entries()].map(([id, entry]) => ({ id, login: entry.login, logins: [...entry.logins] })),
    manual,
  });
}

/** Known accounts for pickers: every registry ID with its current login. */
export async function knownGithubUsers(db: Db): Promise<Array<{ id: string; login: string }>> {
  const index = await ownershipAccountIndex(db);
  return [...index.users.values()].map((u) => ({ id: u.id, login: u.login })).sort((a, b) => a.login.localeCompare(b.login));
}

/* ── Manual mappings ─────────────────────────────────────────────────────── */

export async function listManualMappings(db: Db): Promise<ManualMapping[]> {
  const rows = await db.select<Array<{
    mapping_id: number; match_kind: "email" | "repo_name"; match_value: string; repo_id: number | null;
    github_id: string; login_at_save: string; reviewed_auto_conflict: number;
  }>>("SELECT * FROM ownership_manual_account_map ORDER BY mapping_id");
  return rows.map((row) => ({
    mappingId: row.mapping_id, matchKind: row.match_kind, matchValue: row.match_value, repoId: row.repo_id,
    githubId: row.github_id, loginAtSave: row.login_at_save, reviewedAutoConflict: Boolean(row.reviewed_auto_conflict),
  }));
}

export interface ManualMappingInput {
  matchKind: "email" | "repo_name";
  matchValue: string;
  repoId: number | null;
  githubId: string;
  loginAtSave: string;
  reviewedAutoConflict: boolean;
}

/**
 * Create or replace the mapping for one source. Email rows apply to every
 * repository; name rows are limited to one repository and only apply to
 * identities without an email. A trigger bumps the mapping revision atomically.
 */
export async function saveManualMapping(db: Db, input: ManualMappingInput): Promise<void> {
  const value = input.matchKind === "email" ? normalizeEmail(input.matchValue) : normalizeName(input.matchValue);
  if (!value) throw new Error("A mapping needs an email or a name");
  if (input.matchKind === "repo_name" && input.repoId == null) throw new Error("A name mapping is limited to one repository");
  if (!/^\d+$/.test(input.githubId)) throw new Error("A mapping needs a verified GitHub account ID");
  const now = new Date().toISOString();
  const conflict = input.matchKind === "email" ? "(match_kind, match_value) WHERE repo_id IS NULL" : "(repo_id, match_kind, match_value) WHERE repo_id IS NOT NULL";
  await withWriteLock(() => db.execute(
    `INSERT INTO ownership_manual_account_map
       (match_kind, match_value, repo_id, github_id, login_at_save, reviewed_auto_conflict, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT ${conflict} DO UPDATE SET
       github_id = excluded.github_id, login_at_save = excluded.login_at_save,
       reviewed_auto_conflict = excluded.reviewed_auto_conflict, updated_at = excluded.updated_at`,
    [input.matchKind, value, input.matchKind === "email" ? null : input.repoId, input.githubId, input.loginAtSave,
      input.reviewedAutoConflict ? 1 : 0, now],
  ).then(() => {}));
}

export async function deleteManualMapping(db: Db, mappingId: number): Promise<void> {
  await withWriteLock(() => db.execute("DELETE FROM ownership_manual_account_map WHERE mapping_id = $1", [mappingId]).then(() => {}));
}

/** Every saved HEAD report, for the Settings inventory of unmatched authors. */
export async function allOwnershipReports(db: Db): Promise<Array<{ repoId: number; fullName: string; report: OwnershipReport; history: HistorySource }>> {
  const repos = await db.select<Array<{ repo_id: number }>>("SELECT repo_id FROM line_ownership");
  const revisions = await ownershipRevisions(db, repos.map((r) => r.repo_id));
  const out = [];
  for (const rev of revisions) {
    if (!rev.hasReport) continue;
    const report = await ownershipReport(db, rev.repoId);
    if (report) out.push({ repoId: rev.repoId, fullName: rev.fullName, report, history: rev.history });
  }
  return out;
}
