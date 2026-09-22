import type Database from "@tauri-apps/plugin-sql";
import type { GithubAccount, OwnershipHistoryAuthor, OwnershipHistoryPoint, OwnershipReport } from "../lineOwnership";
import { Params } from "./params";
import { bulkInsert, withWriteLock } from ".";

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

export async function ownershipCheckpoint(db: Database, repoId: number): Promise<string | null> {
  const rows = await db.select<Array<{ snapshot: string }>>(
    "SELECT snapshot FROM line_ownership WHERE repo_id = $1", [repoId],
  );
  return rows[0]?.snapshot ?? null;
}

// Extract only the validity fields: unchanged checks never transfer file caches
// through the WebView. Invalid/legacy snapshots fall back to rebuilding.
const METADATA = `CASE WHEN json_valid(snapshot) THEN CASE WHEN
  json_type(snapshot, '$.files') = 'object' AND json_type(snapshot, '$.coauthors') = 'object'
  AND json_type(snapshot, '$.report.credits') = 'array' THEN json_object(
  'version', json_extract(snapshot, '$.version'),
  'revision', json_extract(snapshot, '$.report.revision'),
  'options', json_extract(snapshot, '$.report.options')) ELSE NULL END ELSE NULL END`;

export async function ownershipMetadata(db: Database, repoId: number): Promise<string | null> {
  const rows = await db.select<Array<{ metadata: string | null }>>(
    `SELECT ${METADATA} AS metadata FROM line_ownership WHERE repo_id = $1`, [repoId],
  );
  return rows[0]?.metadata ?? null;
}

/** Compare-and-update prevents a concurrent reset/write from being mistaken for
 * the snapshot whose remote SHA we checked. Only checked_at changes. */
export async function touchOwnershipSnapshot(db: Database, repoId: number, metadata: string): Promise<boolean> {
  return withWriteLock(async () => {
    const result = await db.execute(
      `UPDATE line_ownership SET checked_at = $1 WHERE repo_id = $2 AND (${METADATA}) = $3`,
      [new Date().toISOString(), repoId, metadata],
    );
    return result.rowsAffected === 1;
  });
}

/** Report, per-file attribution and its exact commit are replaced by ONE atomic
 * statement. A failed/cancelled scan leaves the previous successful snapshot intact. */
export async function writeOwnershipSnapshot(db: Database, repoId: number, snapshot: string, full: boolean): Promise<void> {
  const parsed = JSON.parse(snapshot) as { version: number; report: OwnershipReport };
  const now = new Date().toISOString();
  await withWriteLock(() => db.execute(
    `INSERT INTO line_ownership (repo_id, revision, calculated_at, checked_at, snapshot)
     VALUES ($1, $2, $3, $3, $4)
     ON CONFLICT (repo_id) DO UPDATE SET
       calculated_at = CASE WHEN line_ownership.revision IS excluded.revision AND $5 = 0 AND $6 = 0
         AND json_valid(line_ownership.snapshot)
         AND json_extract(line_ownership.snapshot, '$.version') = json_extract(excluded.snapshot, '$.version')
         THEN line_ownership.calculated_at ELSE excluded.calculated_at END,
       revision = excluded.revision, checked_at = excluded.checked_at, snapshot = excluded.snapshot`,
    [repoId, parsed.report.revision || null, now, snapshot, full ? 1 : 0, parsed.report.filesRecalculated],
  ).then(() => {}));
}

export async function ownershipSnapshots(db: Database, repoIds: number[]): Promise<OwnershipSnapshotRow[]> {
  if (!repoIds.length) return [];
  const p = new Params();
  const ids = repoIds.map((id) => p.add(id)).join(",");
  const rows = await db.select<Array<Omit<OwnershipSnapshotRow, "report"> & { report_json: string | null }>>(
    `SELECT r.id AS repo_id, r.full_name, o.revision, o.calculated_at, o.checked_at,
       s.status, s.error, json_extract(o.snapshot, '$.report') AS report_json
     FROM repos r LEFT JOIN line_ownership o ON o.repo_id = r.id
     LEFT JOIN sync_state s ON s.repo_id = r.id AND s.endpoint = 'line_ownership'
     WHERE r.id IN (${ids}) ORDER BY r.full_name`, p.values,
  );
  return rows.map(({ report_json, ...row }) => ({ ...row, report: report_json ? JSON.parse(report_json) as OwnershipReport : null }));
}

export interface OwnershipHistoryBatch {
  points: Array<{
    revision: string;
    committedAt: string;
    totalLines: number;
    coauthoredLines: number;
    authors: OwnershipHistoryAuthor[];
  }>;
  checkpoint: string;
  reset: boolean;
  done: boolean;
}

/** The rolling file cache for the history walk. An empty checkpoint means start over. */
export async function ownershipHistoryCache(db: Database, repoId: number): Promise<string | null> {
  const rows = await db.select<Array<{ cache: string }>>(
    "SELECT cache FROM line_ownership_history_state WHERE repo_id = $1", [repoId],
  );
  const cache = rows[0]?.cache;
  return cache ? cache : null;
}

/** True when the saved walk already ends at this default-branch commit. */
export async function ownershipHistoryCovers(db: Database, repoId: number, revision: string): Promise<boolean> {
  const rows = await db.select<Array<{ revision: string }>>(
    "SELECT revision FROM line_ownership_history_state WHERE repo_id = $1", [repoId],
  );
  return rows[0]?.revision === revision;
}

export async function clearOwnershipHistory(db: Database, repoId: number): Promise<void> {
  await withWriteLock(async () => {
    await db.execute("DELETE FROM line_ownership_history WHERE repo_id = $1", [repoId]);
    await db.execute("DELETE FROM line_ownership_history_state WHERE repo_id = $1", [repoId]);
  });
}

/** Points are written before the cursor moves, so a crash retries this batch. */
export async function writeOwnershipHistory(
  db: Database, repoId: number, target: string, batch: OwnershipHistoryBatch,
): Promise<void> {
  await withWriteLock(async () => {
    if (batch.reset) {
      await db.execute("DELETE FROM line_ownership_history WHERE repo_id = $1", [repoId]);
      await db.execute("DELETE FROM line_ownership_history_state WHERE repo_id = $1", [repoId]);
    }
    await bulkInsert(db, {
      table: "line_ownership_history",
      columns: ["repo_id", "revision", "committed_at", "total_lines", "coauthored_lines", "authors_json"],
      rows: batch.points.map((point) => [
        repoId, point.revision, point.committedAt, point.totalLines, point.coauthoredLines,
        JSON.stringify(point.authors),
      ]),
      conflictColumns: ["repo_id", "revision"],
      onConflict: "replace",
    });
    const cursor = batch.points.length
      ? batch.points[batch.points.length - 1].revision
      : batch.done ? target : null;
    if (cursor == null) return;
    await db.execute(
      `INSERT INTO line_ownership_history_state (repo_id, revision, target, cache)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo_id) DO UPDATE SET
         revision = excluded.revision, target = excluded.target, cache = excluded.cache`,
      [repoId, cursor, target, batch.checkpoint],
    );
  });
}

/** Last saved point per repository per UTC day. Days with no commit are filled in later. */
export async function ownershipHistory(db: Database, repoIds: number[]): Promise<OwnershipHistoryPoint[]> {
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

/** Emails already resolved, including addresses GitHub could not match. */
export async function knownGithubAccountEmails(db: Database, emails: readonly string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const p = new Params();
  const rows = await db.select<Array<{ email: string }>>(
    `SELECT email FROM github_accounts WHERE email IN ${p.in(emails)}`,
    p.values,
  );
  return new Set(rows.map((row) => row.email));
}

/** Accounts GitHub matched. Unmatched addresses stay out of the join. */
export async function githubAccounts(db: Database): Promise<Map<string, GithubAccount>> {
  const rows = await db.select<Array<{ email: string; login: string; github_id: string }>>(
    "SELECT email, login, github_id FROM github_accounts WHERE login IS NOT NULL AND github_id IS NOT NULL",
  );
  return new Map(rows.map((row) => [row.email, { login: row.login, id: row.github_id }]));
}

/** Remember a lookup. A null login is a miss, so the next sync skips that email. */
export async function writeGithubAccounts(
  db: Database,
  rows: Array<[string, string | null, string | null]>,
): Promise<void> {
  await withWriteLock(() => bulkInsert(db, {
    table: "github_accounts",
    columns: ["email", "login", "github_id"],
    rows,
    conflictColumns: ["email"],
    onConflict: "replace",
  }).then(() => {}));
}
