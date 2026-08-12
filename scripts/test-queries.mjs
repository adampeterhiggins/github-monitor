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
const sync = await bundle("src/lib/ingest/sync.ts", "sync.cjs");
const stacks = await bundle("src/lib/agg/stacks.ts", "stacks.cjs");
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
  sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type = 'table'").get().n === 22,
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

/* ── Author probe: the cold-cache path ────────────────────────────────────── */

// This is the table that makes "repositories I've committed in" work before any
// sync. Reading synced stats instead would be circular: the cache is only
// populated by syncing, but the point of choosing repositories is to avoid
// syncing all of them.
await q.saveAuthorProbe(db, "adampeterhiggins", [
  { repoId: 1, commits: 383, readable: true },
  { repoId: 2, commits: 0, readable: true },
  { repoId: 3, commits: 0, readable: false },
]);

const probe = await q.getAuthorProbe(db, "adampeterhiggins");
T("author probe round-trips", probe.length === 3);
T(
  "probe distinguishes zero commits from unreadable",
  Number(probe.find((r) => r.repo_id === 2).readable) === 1 &&
    Number(probe.find((r) => r.repo_id === 3).readable) === 0,
);
T(
  "probe is case-insensitive on login",
  (await q.getAuthorProbe(db, "ADAMPETERHIGGINS")).length === 3,
);

// Re-probing must update in place, not accumulate duplicate rows.
await q.saveAuthorProbe(db, "adampeterhiggins", [{ repoId: 1, commits: 400, readable: true }]);
const reprobed = await q.getAuthorProbe(db, "adampeterhiggins");
T(
  "re-probing updates in place",
  reprobed.length === 3 && Number(reprobed.find((r) => r.repo_id === 1).commits) === 400,
);

T("probe for another account is separate", (await q.getAuthorProbe(db, "someoneelse")).length === 0);

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

/* ── Resume accounting ────────────────────────────────────────────────────── */

// sync_state is what makes an interrupted sync resumable, so the arithmetic that
// decides "already done" versus "still to do" needs to be right — skipping
// something unfinished would leave a permanent hole in the data.
const EPS = ["contributors", "commit_activity", "traffic"];
sqlite.exec(`INSERT INTO sync_state (repo_id, endpoint, status, last_attempt_at, attempts) VALUES
  (1,'contributors','ok','2026-08-11T00:00:00Z',1),
  (1,'commit_activity','pending','2026-08-11T00:00:00Z',1),
  (1,'traffic','forbidden','2026-08-11T00:00:00Z',1),
  (2,'contributors','error','2026-08-11T00:00:00Z',1),
  (2,'commit_activity','empty','2026-08-11T00:00:00Z',1)`);

const w = await q.outstandingWork(db, [1, 2, 3], EPS);
T(
  "complete counts ok, empty and forbidden",
  w.complete === 3,
  `got ${w.complete} (ok + empty + forbidden)`,
);
T("pending is counted separately", w.pending === 1, `got ${w.pending}`);
T("errored is counted separately", w.errored === 1, `got ${w.errored}`);
// 3 repos x 3 endpoints = 9 expected; 5 have a row, so 4 were never attempted.
T("never-attempted is inferred from the expected total", w.never === 4, `got ${w.never}`);
T(
  "outstanding is what a resume would fetch",
  w.outstanding === 6 && w.outstanding === w.pending + w.errored + w.never,
  `got ${w.outstanding}`,
);
T("resumable when there is both finished and unfinished work", w.resumable === true);

const wNone = await q.outstandingWork(db, [], EPS);
T("no repositories selected means nothing outstanding", wNone.outstanding === 0 && !wNone.resumable);

// Narrowing the endpoint selection must narrow the accounting with it.
const wNarrow = await q.outstandingWork(db, [1], ["contributors"]);
T(
  "accounting respects the endpoint selection",
  wNarrow.complete === 1 && wNarrow.outstanding === 0 && !wNarrow.resumable,
  `complete=${wNarrow.complete} outstanding=${wNarrow.outstanding}`,
);

/* ── The skip decision itself ─────────────────────────────────────────────── */

// Skipping something that did not finish would leave a hole no later resume fills.
const { shouldSkip } = sync;
T("full mode never skips, even finished work", !shouldSkip("ok", "full"));
T("resume skips ok", shouldSkip("ok", "resume"));
T("resume skips empty (a repo with no commits still has none)", shouldSkip("empty", "resume"));
T("resume skips forbidden (no access will not change)", shouldSkip("forbidden", "resume"));
T("resume RETRIES pending (GitHub was still computing)", !shouldSkip("pending", "resume"));
T("resume RETRIES error", !shouldSkip("error", "resume"));
T("resume attempts never-recorded pairs", !shouldSkip(undefined, "resume"));
T("full mode redoes everything", ["ok","empty","forbidden","pending","error"].every((st) => !shouldSkip(st, "full")));

/* ── Breakdown queries ────────────────────────────────────────────────────── */

const repoWeeks = await q.weeklyByRepo(db, IDS, 0, W2 + 1);
// Grouped by (repo, week): (1,W)=17, (2,W2)=10, (3,W)=1.
T(
  "weeklyByRepo splits totals by repository and week",
  repoWeeks.length === 3 && sum(repoWeeks) === 28,
  `rows=${repoWeeks.length} commits=${sum(repoWeeks)}`,
);
T(
  "weeklyByRepo carries the repository name for labelling",
  repoWeeks.every((r) => typeof r.full_name === "string" && r.full_name.includes("/")),
);
T(
  "weeklyByRepo honours the contributor filter",
  sum(await q.weeklyByRepo(db, IDS, 0, W2 + 1, ["claude"])) === 17,
);
T(
  "contributorWeeklyByRepo scopes to one person",
  sum(await q.contributorWeeklyByRepo(db, "claude", IDS, 0, W2 + 1)) === 17,
);
T(
  "contributorWeeklyByRepo is case-insensitive and splits by repo",
  (await q.contributorWeeklyByRepo(db, "CLAUDE", IDS, 0, W2 + 1)).length === 2,
);

// One query serves every contributor card's repository split, so it must return
// the same totals as the per-contributor query it replaced.
const allRepoWeeks = await q.contributorRepoWeeklyAll(db, IDS, 0, W2 + 1);
T(
  "contributorRepoWeeklyAll totals match the whole dataset",
  sum(allRepoWeeks) === 28,
  `commits=${sum(allRepoWeeks)}`,
);
T(
  "contributorRepoWeeklyAll agrees with the single-contributor query",
  sum(allRepoWeeks.filter((r) => r.login.toLowerCase() === "claude")) ===
    sum(await q.contributorWeeklyByRepo(db, "claude", IDS, 0, W2 + 1)),
);
T(
  "contributorRepoWeeklyAll merges login casings",
  new Set(allRepoWeeks.map((r) => r.login.toLowerCase())).size === 3 &&
    allRepoWeeks.filter((r) => r.login.toLowerCase() === "claude").length === 2,
);
T(
  "contributorRepoWeeklyAll honours the contributor filter",
  sum(await q.contributorRepoWeeklyAll(db, IDS, 0, W2 + 1, ["claude"])) === 17,
);

/* ── Stacked breakdowns ───────────────────────────────────────────────────── */

// The palette has eight categorical slots assigned in fixed order and never
// cycled, so a ninth series must fold into "Other" rather than take an invented
// colour. Totals must survive the fold, or the stack silently under-reports.
{
  const { buildStacks, OTHER_KEY } = stacks;
  const WEEKS = [100, 200, 300];
  const rows = [];
  // 12 entities, descending totals, so 8 take slots and 4 fold.
  for (let i = 0; i < 12; i++) {
    for (const w of WEEKS) rows.push({ w, k: `e${i}`, v: (12 - i) * 10 });
  }
  const built = buildStacks({
    rows,
    weeks: WEEKS,
    weekOf: (r) => r.w,
    keyOf: (r) => r.k,
    labelOf: (r) => r.k,
    valueOf: (r) => r.v,
  });

  T("stack emits one row per requested week", built.data.length === WEEKS.length);
  T(
    "at most eight slots, plus a single Other band",
    built.series.length === 9 && built.series.filter((x) => x.slot != null).length === 8,
    `series=${built.series.length}`,
  );
  T("Other is the last band and has no slot", built.series[8].key === OTHER_KEY && built.series[8].slot === null);
  T("folded count is reported", built.foldedCount === 4, `folded=${built.foldedCount}`);
  T(
    "slots are assigned in rank order, highest total first",
    built.series[0].key === "e0" && built.series[7].key === "e7",
  );

  // Nothing may be lost in the fold.
  const grand = rows.reduce((a, r) => a + r.v, 0);
  const stacked = built.data.reduce(
    (a, row) => a + Object.entries(row).filter(([k]) => k !== "week").reduce((x, [, v]) => x + v, 0),
    0,
  );
  T("the fold conserves the total", stacked === grand, `stacked=${stacked} grand=${grand}`);

  // Weeks with no data still need a row, or the axis develops holes.
  const sparse = buildStacks({
    rows: [{ w: 100, k: "a", v: 5 }],
    weeks: [100, 200, 300],
    weekOf: (r) => r.w,
    keyOf: (r) => r.k,
    labelOf: (r) => r.k,
    valueOf: (r) => r.v,
  });
  T(
    "weeks without data appear as zeroes",
    sparse.data.length === 3 && sparse.data[1].a === 0 && sparse.data[2].a === 0,
  );
  T("no Other band when nothing folds", sparse.series.length === 1 && sparse.foldedCount === 0);

  // Ties must not reorder between renders, or colours flicker.
  const tie = () =>
    buildStacks({
      rows: [
        { w: 1, k: "b", v: 5 },
        { w: 1, k: "a", v: 5 },
      ],
      weeks: [1],
      weekOf: (r) => r.w,
      keyOf: (r) => r.k,
      labelOf: (r) => r.k,
      valueOf: (r) => r.v,
    });
  T("ties break deterministically", tie().series[0].key === tie().series[0].key && tie().series[0].key === "a");

  // Zero-valued rows must not create a phantom series.
  const zeros = buildStacks({
    rows: [{ w: 1, k: "ghost", v: 0 }, { w: 1, k: "real", v: 3 }],
    weeks: [1],
    weekOf: (r) => r.w,
    keyOf: (r) => r.k,
    labelOf: (r) => r.k,
    valueOf: (r) => r.v,
  });
  T("entities with no activity are omitted", zeros.series.length === 1 && zeros.series[0].key === "real");
}

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
