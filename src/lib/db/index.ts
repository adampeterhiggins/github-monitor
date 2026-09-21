import Database from "@tauri-apps/plugin-sql";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

let dbPromise: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await Database.load("sqlite:github-monitor.db");
      // WAL is a property of the database file, so it holds no matter which pooled
      // connection sets it — and it is what lets the UI keep reading during a sync.
      await db.execute("PRAGMA journal_mode = WAL");
      // Per-connection PRAGMAs only affect whichever pooled connection served this
      // call, so neither of the next two can be relied on globally. `busy_timeout`
      // is best-effort; write contention is actually handled by serialising writes
      // through `withWriteLock` below. Nothing here depends on foreign-key
      // enforcement for correctness.
      await db.execute("PRAGMA busy_timeout = 5000");
      await db.execute("PRAGMA foreign_keys = ON");
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

/* ────────────────────────────────────────────────────────────────────────────
   Why there are no BEGIN/COMMIT statements in this file
   ────────────────────────────────────────────────────────────────────────────
   tauri-plugin-sql connects with sqlx's `Pool::connect`, whose default is
   max_connections = 10. Each `db.execute()` therefore borrows an arbitrary
   connection from that pool, and a transaction opened by one `execute("BEGIN")`
   is invisible to the next call if it lands elsewhere.

   Issuing BEGIN / COMMIT as separate execute() calls produced two failures in
   practice, both seen while syncing concurrently:
     - "cannot start a transaction within a transaction" (two BEGINs on one
        connection, from two repositories being written at once)
     - "cannot commit - no transaction is active"        (COMMIT on a connection
        that never saw the BEGIN)

   So multi-statement atomicity is not available here. Instead:
     - each write is a single statement, which SQLite makes atomic on its own;
       `bulkInsert` batches many rows into one multi-row INSERT for this reason;
     - a delete-then-repopulate pair runs under `withWriteLock` so the two
       statements stay adjacent and concurrent writers do not interleave.

   The residual risk is a reader observing a repository mid-replacement and
   briefly seeing fewer rows. That is a transient during sync, not corruption,
   and a failed write is recorded in `sync_state` and retried next sync.
   ──────────────────────────────────────────────────────────────────────────── */

let writeChain: Promise<void> = Promise.resolve();

/**
 * Serialise a sequence of writes against every other sequence.
 *
 * Callers must not nest this: the lock is not re-entrant, because a global
 * "already held" flag cannot distinguish a nested call from a concurrent one in
 * a single-threaded event loop. `bulkInsert` deliberately does no locking of its
 * own so that callers own the boundary.
 */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn);
  // Keep the chain usable even when a link rejects.
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * SQLite's default bound-parameter ceiling is 999. Multi-row INSERTs are batched
 * to stay under it — one IPC round trip per batch instead of per row, which is the
 * difference between a usable sync and an unusable one at ~300k weekly rows.
 *
 * Does not open a transaction, and does not take the write lock; wrap calls in
 * `withWriteLock` when ordering against other statements matters.
 */
const MAX_PARAMS = 900;

export interface BulkInsertSpec {
  table: string;
  columns: string[];
  rows: unknown[][];
  /** Conflict target; on conflict, all non-key columns are updated. */
  conflictColumns?: string[];
  /** `replace` overwrites on conflict, `ignore` keeps the existing row. */
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
  return written;
}

/**
 * Replace one repository's rows in a table.
 *
 * GitHub restates history (rebases, force pushes), so a repository's rows are
 * replaced wholesale rather than merged. The delete and the insert are held
 * adjacent by the write lock; see the note above on why this is not a transaction.
 */
export async function replaceRepoRows(
  db: Database,
  table: string,
  repoId: number,
  spec: Omit<BulkInsertSpec, "table">,
): Promise<void> {
  await withWriteLock(async () => {
    await db.execute(`DELETE FROM ${table} WHERE repo_id = $1`, [repoId]);
    await bulkInsert(db, { table, ...spec });
  });
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
    "line_ownership",
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
  await withWriteLock(async () => {
    for (const t of tables) await db.execute(`DELETE FROM ${t}`);
  });
  // traffic_daily is deliberately preserved: it holds history GitHub has dropped.
}
