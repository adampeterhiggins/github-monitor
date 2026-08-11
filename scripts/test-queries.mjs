#!/usr/bin/env node
/**
 * Query-layer tests.
 *
 *   npm run test:queries
 *
 * Runs the real query functions against a real SQLite database built from the real
 * schema, using Node's built-in `node:sqlite`. No GitHub access and no Tauri
 * runtime needed: `queries.ts` only type-imports the SQL plugin, so it can be
 * bundled and driven with a thin adapter.
 *
 * This exists because two classes of bug are invisible to `tsc`:
 *   - SQL that is syntactically fine but references a column that does not exist;
 *   - filters that parse and run but return the wrong rows.
 * Both have already been caught here: a schema statement severed by a semicolon
 * inside a comment, and a contributor list that split one person across two rows
 * when login casing differed.
 */

import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const work = mkdtempSync(join(tmpdir(), "gm-test-"));

// getDb() is never reached, so the plugin only needs to resolve.
const stub = join(work, "stub.mjs");
writeFileSync(stub, "export default { load: async () => ({}) };\n");

async function bundle(entry, out) {
  const file = join(work, out);
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: file,
    logLevel: "error",
    alias: { "@tauri-apps/plugin-sql": stub },
  });
  return require(file);
}

const q = await bundle("src/lib/db/queries.ts", "queries.cjs");
const { splitStatements } = await bundle("src/lib/db/index.ts", "dbindex.cjs");
const { SCHEMA_SQL } = await bundle("src/lib/db/schema.ts", "schema.cjs");

const sqlite = new DatabaseSync(":memory:");
for (const stmt of splitStatements(SCHEMA_SQL)) sqlite.exec(stmt);

let failures = 0;
const T = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

T(
  "schema applies cleanly",
  sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type = 'table'").get().n === 21,
);

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

sqlite.exec(`INSERT INTO repos (id,owner,name,full_name) VALUES
  (1,'o','a','o/a'),(2,'o','b','o/b'),(3,'o','c','o/c')`);

const W = 1745107200; // a Sunday 00:00 UTC
const W2 = W + 604800;

// 'Claude' and 'claude' are the same GitHub account. The cache's primary key is
// case-sensitive, so the read layer has to merge them.
const weeks = [
  [1, "Claude", W, 10, 100, 10],
  [1, "adampeterhiggins", W, 5, 50, 5],
  [1, "someoneelse", W, 2, 20, 2],
  [2, "claude", W2, 7, 70, 7],
  [2, "adampeterhiggins", W2, 3, 30, 3],
  [3, "someoneelse", W, 1, 10, 1],
];
const insWeek = sqlite.prepare(
  "INSERT INTO contributor_weeks (repo_id,login,week,commits,additions,deletions) VALUES (?,?,?,?,?,?)",
);
for (const r of weeks) insWeek.run(...r);

// Repo-wide line counts differ from the sum of attributed contributors on purpose.
sqlite.exec(`INSERT INTO code_frequency (repo_id,week,additions,deletions) VALUES (1,${W},999,99)`);

sqlite.exec(`INSERT INTO pull_requests (repo_id,number,author,title,state,created_at,merged_at)
  VALUES (1,1,'claude','x','MERGED','2026-05-02T00:00:00Z','2026-05-03T00:00:00Z'),
         (1,2,'someoneelse','y','OPEN','2026-05-04T00:00:00Z',NULL)`);

/* ── Adapter: the plugin's async API over node:sqlite ─────────────────────── */

/**
 * `$1` is a *named* SQLite parameter, and several queries reference the same one
 * more than once (a date bound reused across CASE arms, say). Rewriting each
 * occurrence to a positional `?` would wrongly create one parameter per mention,
 * so bind by name — which is also how sqlx binds them in the real app.
 */
const named = (params) => Object.fromEntries(params.map((v, i) => [String(i + 1), v ?? null]));

const db = {
  select: async (sql, params = []) => sqlite.prepare(sql).all(named(params)),
  execute: async (sql, params = []) => {
    sqlite.prepare(sql).run(named(params));
    return { rowsAffected: 0 };
  },
};

const IDS = [1, 2, 3];
const sum = (rows, key = "commits") => rows.reduce((a, r) => a + Number(r[key]), 0);

/* ── Contributor filter semantics ─────────────────────────────────────────── */

T("unfiltered totals include everyone", sum(await q.contributorWeeklyTotals(db, IDS, 0, W2 + 1)) === 28);

T(
  "filter matches whatever casing is stored",
  sum(await q.contributorWeeklyTotals(db, IDS, 0, W2 + 1, ["claude"])) === 17,
);

T(
  "the supplied login is case-insensitive too",
  sum(await q.contributorWeeklyTotals(db, IDS, 0, W2 + 1, ["CLAUDE"])) === 17,
);

T(
  "multi-login filter sums both people",
  sum(await q.contributorWeeklyTotals(db, IDS, 0, W2 + 1, ["claude", "adampeterhiggins"])) === 25,
);

// The asymmetry with the repo filter: no contributors chosen must mean everyone.
T(
  "an empty login list means unfiltered, not empty",
  sum(await q.contributorWeeklyTotals(db, IDS, 0, W2 + 1, [])) === 28,
);
T(
  "a null login list means unfiltered",
  sum(await q.contributorWeeklyTotals(db, IDS, 0, W2 + 1, null)) === 28,
);

T(
  "repo and contributor filters compose",
  sum(await q.contributorWeeklyTotals(db, [1], 0, W2 + 1, ["claude"])) === 10,
);
T(
  "no repositories selected yields nothing",
  sum(await q.contributorWeeklyTotals(db, [], 0, W2 + 1, ["claude"])) === 0,
);

/* ── Identity merging ─────────────────────────────────────────────────────── */

const contribs = await q.listContributors(db, IDS);
T(
  "listContributors merges login casings into one person",
  contribs.length === 3 && Number(contribs[0].commits) === 17,
  contribs.map((c) => `${c.login}:${c.commits}`).join(", "),
);
T(
  "listContributors counts distinct repositories per person",
  Number(contribs.find((c) => c.login.toLowerCase() === "adampeterhiggins").repos) === 2,
);

const cards = await q.contributorWeeklyByLogin(db, IDS, 0, W2 + 1);
T(
  "contributor cards merge casings but keep weeks separate",
  [...new Set(cards.map((c) => c.login.toLowerCase()))].length === 3 &&
    sum(cards.filter((c) => c.login.toLowerCase() === "claude")) === 17,
);

/* ── Source switching on Code frequency ───────────────────────────────────── */

const cfAll = await q.codeFrequencyWeekly(db, IDS, 0, W2 + 1);
T(
  "unfiltered code frequency reads GitHub's repo-wide series",
  cfAll.length === 1 && Number(cfAll[0].additions) === 999,
);
const cfMine = await q.codeFrequencyWeekly(db, IDS, 0, W2 + 1, ["claude"]);
T(
  "filtered code frequency reads per-contributor line counts",
  sum(cfMine, "additions") === 170,
  `got ${sum(cfMine, "additions")}, expected 100+70`,
);

/* ── Repo presets ─────────────────────────────────────────────────────────── */

T("reposContributedTo is case-insensitive", (await q.reposContributedTo(db, "ADAMPETERHIGGINS")).length === 2);
T("an unknown login yields no repositories", (await q.reposContributedTo(db, "nobody")).length === 0);
T("repoActivity covers every repository with commits", (await q.repoActivity(db)).length === 3);

/* ── Pulse ────────────────────────────────────────────────────────────────── */

const pulseAll = await q.pulseSummary(db, IDS, "2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z", 0, W2 + 1);
T("pulse counts all authors when unfiltered", pulseAll.prsOpened === 2 && pulseAll.prsMerged === 1);

const pulseMine = await q.pulseSummary(
  db, IDS, "2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z", 0, W2 + 1, ["claude"],
);
T(
  "pulse honours the contributor filter",
  pulseMine.prsOpened === 1 && pulseMine.prsMerged === 1,
  `opened=${pulseMine.prsOpened} merged=${pulseMine.prsMerged}`,
);

/* ── No manual transactions anywhere ──────────────────────────────────────── */

// Real transactions are unavailable through the plugin's connection pool, so a
// stray BEGIN/COMMIT is a bug that only shows up under concurrent sync.
const seen = [];
const spy = {
  select: async (sql, params = []) => {
    seen.push(sql);
    return db.select(sql, params);
  },
  execute: async (sql, params = []) => {
    seen.push(sql);
    return db.execute(sql, params);
  },
};
await q.setRepoSelection(spy, [{ repoId: 1, included: true }]);
await q.listRepos(spy, "o");
T(
  "no query issues BEGIN/COMMIT/ROLLBACK",
  !seen.some((s) => /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)),
);
T(
  "setRepoSelection persists as a single upsert",
  Number(sqlite.prepare("SELECT included FROM repo_selection WHERE repo_id = 1").get().included) === 1,
);

console.log(failures === 0 ? "\nAll query tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
