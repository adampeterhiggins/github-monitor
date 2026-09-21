#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const work = mkdtempSync(join(tmpdir(), "gm-ownership-"));
let sqlite;
try {
  const output = join(work, "ownership.cjs");
  const modules = ["src/lib/lineOwnership.ts", "src/lib/db/lineOwnership.ts", "src/lib/db/index.ts", "src/lib/db/schema.ts", "src/lib/ingest/sync.ts"];
  await build({
    stdin: { contents: modules.map((path) => `export * from ${JSON.stringify(resolve(path))};`).join("\n"), resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "cjs", outfile: output,
    plugins: [{ name: "tauri-fixture", setup(build) {
      build.onResolve({ filter: /^@tauri-apps\/(api\/core|plugin-sql|plugin-http)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: args.path.endsWith("plugin-sql")
        ? 'export default { load: async () => { throw new Error("Unexpected plugin load"); } };'
        : args.path.endsWith("plugin-http") ? 'export const fetch = (...args) => globalThis.__http(...args);'
        : 'export class Channel {} export const invoke = (...args) => globalThis.__invoke(...args);' }));
    } }],
  });
  const lib = createRequire(import.meta.url)(output);
  const { aggregateOwnership, ownershipCsv, ownershipSnapshots, ownershipCheckpoint, runSync } = lib;
  const alice = { name: "Alice", email: "alice@x" };
  const alias = { name: "Alias", email: "work@x" };
  const bot = { name: "robot[bot]", email: "bot@x" };
  const reports = [{ credits: [{ lines: 5, people: [alice, alias] }] }, { credits: [{ lines: 2, people: [{ name: "Alice", email: "work@x" }] }] }];
  const merged = aggregateOwnership(reports);
  assert.equal(merged.authors.length, 1);
  assert.equal(merged.totalLines, 7);
  assert.equal(merged.creditedLines, 7, "cross-repo alias merging must not double-credit co-authored lines");
  assert.equal(aggregateOwnership(reports, "email").creditedLines, 12);
  const bots = [{ credits: [{ lines: 3, people: [bot] }, { lines: 4, people: [bot, alice] }] }];
  assert.equal(aggregateOwnership(bots, "person", true).totalLines, 4);
  assert.equal(aggregateOwnership(bots, "person", true).creditedLines, 4);
  assert.equal(aggregateOwnership([]).totalLines, 0);
  const csv = ownershipCsv({ totalLines: 3, authors: [
    { author: 'Name, "Quoted"', lines: 3, share: 1, emails: ["person@example.com"] },
    { author: '=HYPERLINK("evil")', lines: 1, share: 1 / 3, emails: ["+formula@example.com"] },
  ] });
  assert.ok(csv.includes('"Name, ""Quoted""","3","1","person@example.com"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""evil"")"'));
  assert.ok(csv.includes('"\'+formula@example.com"'));
  console.log("PASS  org-wide aliases, co-author deduplication, bot denominator, CSV escaping and formula safety");

  const databasePath = join(work, "test.sqlite");
  sqlite = new DatabaseSync(databasePath);
  for (const statement of lib.splitStatements(lib.SCHEMA_SQL)) sqlite.exec(statement);
  const named = (params) => Object.fromEntries(params.map((v, i) => [String(i + 1), v ?? null]));
  let failWrite = false;
  const db = {
    select: async (sql, params = []) => sqlite.prepare(sql).all(named(params)),
    execute: async (sql, params = []) => {
      assert.ok(!/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql));
      if (failWrite && sql.includes("INSERT INTO line_ownership")) throw new Error("disk failure");
      sqlite.prepare(sql).run(named(params));
      return { rowsAffected: 1 };
    },
  };
  const repos = [1, 2, 3].map((id) => ({ id, name: `repo${id}`, full_name: `org/repo${id}`, archived: id === 3,
    size: 10, pushed_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z" }));
  globalThis.__http = async (url) => {
    assert.ok(String(url).includes("/orgs/org/repos"));
    return new Response(JSON.stringify(repos), { status: 200, headers: { "content-type": "application/json" } });
  };
  const snapshot = (revision, lines = 3) => JSON.stringify({ version: 1, files: { "code.txt": { counts: { [revision]: { lines } } } }, coauthors: {},
    report: { revision, repo: "org/repo", credits: [{ lines, people: [alice] }], totalLines: lines, creditedLines: lines, coauthoredLines: 0,
      filesBlamed: 1, filesSkipped: {}, filesReused: 1, filesRecalculated: 0, authors: [] } });
  let calls = [];
  let revision = "a".repeat(40);
  globalThis.__invoke = async (command, args) => {
    assert.equal(command, "sync_line_ownership");
    assert.equal(args.token, "fixture-token");
    calls.push(args);
    args.onProgress.onmessage({ completed: 1, total: 1, phase: "Ownership updated" });
    return snapshot(revision);
  };
  const options = { db, token: "fixture-token", org: "org", endpoints: ["line_ownership"], repoIds: [1, 2, 3] };
  assert.ok(lib.ALL_ENDPOINTS.includes("line_ownership"));
  await runSync(options);
  assert.equal(calls.length, 2, "normal org sync calculates every selected non-archived repo");
  assert.ok(calls.every((c) => c.previousJson === null && !c.full));
  let rows = await ownershipSnapshots(db, [1, 2, 3]);
  assert.equal(rows.filter((r) => r.report).length, 2);
  assert.equal(rows[0].revision, revision);
  assert.equal(rows[2].report, null, "missing snapshots stay visible");
  assert.equal((await ownershipSnapshots(db, [])).length, 0);
  assert.equal((await ownershipSnapshots(db, [2]))[0].repo_id, 2);
  const saved = await ownershipCheckpoint(db, 1);
  sqlite.close();
  sqlite = new DatabaseSync(databasePath);
  assert.equal(await ownershipCheckpoint(db, 1), saved, "checkpoint persists across application restarts");
  calls = [];
  await runSync({ ...options, mode: "resume" });
  assert.equal(calls.length, 0, "resume skips completed ownership endpoints");
  sqlite.exec("UPDATE line_ownership SET calculated_at = '2020-01-01T00:00:00Z'");
  await runSync(options);
  assert.equal(calls.length, 2, "incremental sync checks heads even when inventory timestamps are old");
  assert.ok(calls.every((c) => JSON.parse(c.previousJson).report.revision === revision));
  assert.equal((await ownershipSnapshots(db, [1]))[0].calculated_at, "2020-01-01T00:00:00Z", "unchanged heads retain calculation time");
  calls = [];
  await runSync({ ...options, mode: "full" });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.full && c.previousJson === null));
  assert.notEqual((await ownershipSnapshots(db, [1]))[0].calculated_at, "2020-01-01T00:00:00Z");
  console.log("PASS  sync integration, selection/archives, durable commits, restart, resume, incremental checkpoints and full rebuild");

  const beforeFailure = await ownershipCheckpoint(db, 1);
  globalThis.__invoke = async () => { throw new Error("Git fetch failed"); };
  const failed = await runSync({ ...options, repoIds: [1] });
  assert.equal(failed.errors[0].endpoint, "line_ownership");
  assert.equal(await ownershipCheckpoint(db, 1), beforeFailure);
  assert.equal((await ownershipSnapshots(db, [1]))[0].status, "error");
  assert.match((await ownershipSnapshots(db, [1]))[0].error, /Git fetch failed/);
  let resumed = false;
  revision = "b".repeat(40);
  globalThis.__invoke = async (_, args) => { resumed = true; assert.ok(args.previousJson); return snapshot(revision); };
  await runSync({ ...options, repoIds: [1], mode: "resume" });
  assert.equal(resumed, true);
  assert.equal((await ownershipSnapshots(db, [1]))[0].revision, revision);
  const latest = await ownershipCheckpoint(db, 1);
  const controller = new AbortController();
  let cancelCalled = false;
  globalThis.__invoke = async (command) => {
    if (command === "cancel_line_ownership") { cancelCalled = true; return; }
    controller.abort();
    return snapshot("c".repeat(40));
  };
  const cancelled = await runSync({ ...options, repoIds: [1], signal: controller.signal });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelCalled, true);
  assert.equal(await ownershipCheckpoint(db, 1), latest, "cancellation must not advance the checkpoint");
  assert.equal((await ownershipSnapshots(db, [1]))[0].status, "pending", "cancelled refresh remains resumable");
  failWrite = true;
  globalThis.__invoke = async () => snapshot("d".repeat(40));
  const writeFailed = await runSync({ ...options, repoIds: [1] });
  assert.equal(writeFailed.errors.length, 1);
  assert.equal(await ownershipCheckpoint(db, 1), latest, "failed atomic write keeps old cache, SHA and report together");
  failWrite = false;
  await lib.clearAnalytics(db);
  assert.equal(await ownershipCheckpoint(db, 1), null);
  console.log("PASS  failed fetch/write retention, cancellation, retry and analytics reset");
} finally {
  sqlite?.close();
  rmSync(work, { recursive: true, force: true });
}
