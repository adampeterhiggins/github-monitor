import type Database from "@tauri-apps/plugin-sql";
import type { OwnershipReport } from "../lineOwnership";
import { Params } from "./params";
import { withWriteLock } from ".";

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
