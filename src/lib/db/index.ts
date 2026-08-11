import Database from "@tauri-apps/plugin-sql";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

let dbPromise: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await Database.load("sqlite:github-monitor.db");
      // WAL keeps reads from blocking behind a long ingestion write.
      await db.execute("PRAGMA journal_mode = WAL");
      await db.execute("PRAGMA foreign_keys = ON");
      await db.execute("PRAGMA synchronous = NORMAL");
      for (const stmt of splitStatements(SCHEMA_SQL)) {
        await db.execute(stmt);
      }
      await db.execute(
        "INSERT INTO meta (key, value) VALUES ('schema_version', $1) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [String(SCHEMA_VERSION)],
      );
      return db;
    })();
  }
  return dbPromise;
}

/**
 * The plugin executes one statement per call, so the schema has to be split.
 *
 * A plain `sql.split(";")` is wrong: a `--` comment or a quoted string may contain
 * a semicolon, which severs the statement mid-way. This tracks comment and quote
 * state so only real statement terminators split.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inLineComment = false;
  let inBlockComment = false;
  let quote: '"' | "'" | "`" | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (quote) {
      current += ch;
      // '' inside a single-quoted string is an escaped quote, not a terminator.
      if (ch === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      current += ch + next;
      i++;
      inLineComment = true;
      continue;
    }
    if (ch === "/" && next === "*") {
      current += ch + next;
      i++;
      inBlockComment = true;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(`${trimmed};`);
      current = "";
      continue;
    }
    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/**
 * SQLite's default bound-parameter ceiling is 999. Multi-row INSERTs are batched
 * to stay under it — one IPC round trip per batch instead of per row, which is the
 * difference between a usable sync and an unusable one at ~300k weekly rows.
 */
const MAX_PARAMS = 900;

export interface BulkInsertSpec {
  table: string;
  columns: string[];
  rows: unknown[][];
  /** Conflict target; defaults to the table's primary key via DO UPDATE on all non-key columns. */
  conflictColumns?: string[];
  /** `replace` overwrites on conflict, `ignore` keeps the existing row, `sum` adds numeric columns. */
  onConflict?: "replace" | "ignore";
}

export async function bulkInsert(db: Database, spec: BulkInsertSpec): Promise<number> {
  const { table, columns, rows } = spec;
  if (rows.length === 0) return 0;

  const perRow = columns.length;
  const rowsPerBatch = Math.max(1, Math.floor(MAX_PARAMS / perRow));
  const mode = spec.onConflict ?? "replace";

  let conflictClause = "";
  if (mode === "ignore") {
    conflictClause = " ON CONFLICT DO NOTHING";
  } else if (spec.conflictColumns?.length) {
    const updates = columns
      .filter((c) => !spec.conflictColumns!.includes(c))
      .map((c) => `${c} = excluded.${c}`)
      .join(", ");
    conflictClause = updates
      ? ` ON CONFLICT (${spec.conflictColumns.join(", ")}) DO UPDATE SET ${updates}`
      : " ON CONFLICT DO NOTHING";
  }

  let written = 0;
  await db.execute("BEGIN");
  try {
    for (let i = 0; i < rows.length; i += rowsPerBatch) {
      const batch = rows.slice(i, i + rowsPerBatch);
      const params: unknown[] = [];
      const tupleSql: string[] = batch.map((row) => {
        const placeholders = row.map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        return `(${placeholders.join(", ")})`;
      });

      const verb =
        mode === "replace" && !spec.conflictColumns ? "INSERT OR REPLACE INTO" : "INSERT INTO";
      const sql = `${verb} ${table} (${columns.join(", ")}) VALUES ${tupleSql.join(", ")}${conflictClause}`;
      await db.execute(sql, params);
      written += batch.length;
    }
    await db.execute("COMMIT");
  } catch (err) {
    await db.execute("ROLLBACK");
    throw err;
  }
  return written;
}

export async function setMeta(db: Database, key: string, value: string): Promise<void> {
  await db.execute(
    "INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export async function getMeta(db: Database, key: string): Promise<string | null> {
  const rows = await db.select<Array<{ value: string }>>("SELECT value FROM meta WHERE key = $1", [
    key,
  ]);
  return rows[0]?.value ?? null;
}

export type SyncStatus = "ok" | "pending" | "error" | "forbidden" | "empty";

export async function recordSync(
  db: Database,
  repoId: number,
  endpoint: string,
  status: SyncStatus,
  extra: { etag?: string | null; error?: string | null } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO sync_state (repo_id, endpoint, status, etag, last_ok_at, last_attempt_at, attempts, error)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
     ON CONFLICT (repo_id, endpoint) DO UPDATE SET
       status = excluded.status,
       etag = COALESCE(excluded.etag, sync_state.etag),
       last_ok_at = COALESCE(excluded.last_ok_at, sync_state.last_ok_at),
       last_attempt_at = excluded.last_attempt_at,
       attempts = sync_state.attempts + 1,
       error = excluded.error`,
    [
      repoId,
      endpoint,
      status,
      extra.etag ?? null,
      status === "ok" ? now : null,
      now,
      extra.error ?? null,
    ],
  );
}

export async function getSyncState(
  db: Database,
  endpoint: string,
): Promise<Map<number, { status: SyncStatus; etag: string | null; lastOkAt: string | null }>> {
  const rows = await db.select<
    Array<{ repo_id: number; status: SyncStatus; etag: string | null; last_ok_at: string | null }>
  >("SELECT repo_id, status, etag, last_ok_at FROM sync_state WHERE endpoint = $1", [endpoint]);
  return new Map(
    rows.map((r) => [r.repo_id, { status: r.status, etag: r.etag, lastOkAt: r.last_ok_at }]),
  );
}

/** Wipe cached analytics but keep repo metadata and the user's repo selection. */
export async function clearAnalytics(db: Database): Promise<void> {
  const tables = [
    "contributor_weeks",
    "commit_activity",
    "participation",
    "code_frequency",
    "punchcard",
    "traffic_paths",
    "traffic_referrers",
    "community",
    "forks",
    "branches",
    "dependencies",
    "dependabot_alerts",
    "workflow_runs",
    "pull_requests",
    "issues",
    "sync_state",
  ];
  await db.execute("BEGIN");
  try {
    for (const t of tables) await db.execute(`DELETE FROM ${t}`);
    await db.execute("COMMIT");
  } catch (err) {
    await db.execute("ROLLBACK");
    throw err;
  }
  // traffic_daily is deliberately preserved: it holds history GitHub has dropped.
}
