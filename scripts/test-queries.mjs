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

// Tauri's fetch is the only way out to the network, so routing it at a global lets
// the ingestion code run against a fake GitHub without touching the code itself.
const httpStub = join(work, "http.mjs");
writeFileSync(
  httpStub,
  "export const fetch = (...args) => globalThis.__ghFetch(...args);\n",
);

async function bundle(entry, out) {
  const file = join(work, out);
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: file,
    logLevel: "error",
    alias: { "@tauri-apps/plugin-sql": stub, "@tauri-apps/plugin-http": httpStub },
  });
  return require(file);
}

const q = await bundle("src/lib/db/queries.ts", "queries.cjs");
const sync = await bundle("src/lib/ingest/sync.ts", "sync.cjs");
const stacks = await bundle("src/lib/agg/stacks.ts", "stacks.cjs");
const series = await bundle("src/lib/agg/series.ts", "series.cjs");
const weeksLib = await bundle("src/lib/agg/weeks.ts", "weeks.cjs");
const metrics = await bundle("src/lib/agg/metrics.ts", "metrics.cjs");
const concentration = await bundle("src/lib/agg/concentration.ts", "concentration.cjs");
const { splitStatements } = await bundle("src/lib/db/index.ts", "dbindex.cjs");
const { SCHEMA_SQL } = await bundle("src/lib/db/schema.ts", "schema.cjs");

const sqlite = new DatabaseSync(":memory:");
for (const stmt of splitStatements(SCHEMA_SQL)) sqlite.exec(stmt);

let failures = 0;
const T = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

{
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_"));
  const expected = [
    "author_repo_probe", "branches", "code_frequency", "commit_activity", "community",
    "contributor_weeks", "contributors", "dependabot_alerts", "dependencies", "forks",
    "issues", "meta", "participation", "public.repos", "pull_requests", "punchcard",
    "repo_selection", "repos", "saved_filters", "sync_state", "traffic_daily",
    "traffic_paths", "traffic_referrers", "workflow_runs",
  ].filter((t) => t !== "public.repos");
  const missing = expected.filter((t) => !tables.includes(t));
  T(
    "schema applies cleanly",
    missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : `${tables.length} tables`,
  );
}

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

/* ── Commit extent, for the "All commits" period ──────────────────────────── */

{
  const all = await q.commitWeekBounds(db, IDS);
  T(
    "commit bounds span the first and last week with commits",
    all.firstWeek === W && all.lastWeek === W2,
    JSON.stringify(all),
  );

  // Repo 1 only has rows in the first week; repo 2 only in the second.
  const one = await q.commitWeekBounds(db, [1]);
  T("bounds narrow to the selected repositories", one.firstWeek === W && one.lastWeek === W, JSON.stringify(one));

  const claude = await q.commitWeekBounds(db, IDS, ["claude"]);
  T(
    "bounds respect the contributor filter, casing and all",
    claude.firstWeek === W && claude.lastWeek === W2,
    JSON.stringify(claude),
  );
  const oneOnly = await q.commitWeekBounds(db, IDS, ["someoneelse"]);
  T("a contributor with one week gets a single-week span",
    oneOnly.firstWeek === W && oneOnly.lastWeek === W, JSON.stringify(oneOnly));

  T("no repositories selected has no bounds", (await q.commitWeekBounds(db, [])) === null);
  T("an unknown contributor has no bounds",
    (await q.commitWeekBounds(db, IDS, ["nobody"])) === null);

  // A zero-commit row must not extend the span, or the range claims history that
  // has no commits in it.
  sqlite.exec(
    `INSERT INTO contributor_weeks (repo_id,login,week,commits,additions,deletions)
     VALUES (1,'quiet',${W2 + 604800},0,0,0)`,
  );
  const afterZero = await q.commitWeekBounds(db, IDS);
  T("a week with no commits does not extend the span", afterZero.lastWeek === W2, JSON.stringify(afterZero));
  sqlite.exec(`DELETE FROM contributor_weeks WHERE login = 'quiet'`);
}

/* ── Per-contributor extents, for the card action ──────────────────────────── */

// This drives "set the period to all their commits", so a span that is short by a
// week silently hides commits the card was opened to look at.
{
  const rows = await q.contributorWeekBounds(db, IDS);
  const byLogin = new Map(rows.map((r) => [r.login.toLowerCase(), r]));

  T("one row per contributor, not per repository", rows.length === 3, `${rows.length} rows`);
  T(
    "casings merge into one span",
    Number(byLogin.get("claude").first_week) === W && Number(byLogin.get("claude").last_week) === W2,
    JSON.stringify(byLogin.get("claude")),
  );
  T(
    "a contributor with one week spans that week",
    Number(byLogin.get("someoneelse").first_week) === W &&
      Number(byLogin.get("someoneelse").last_week) === W,
    JSON.stringify(byLogin.get("someoneelse")),
  );

  // Scoped to the selected repositories, like everything else on the page.
  const repo2 = await q.contributorWeekBounds(db, [2]);
  T(
    "extents narrow to the selected repositories",
    repo2.every((r) => Number(r.first_week) === W2),
    JSON.stringify(repo2.map((r) => [r.login, r.first_week])),
  );
  T("no repositories selected yields no extents", (await q.contributorWeekBounds(db, [])).length === 0);

  // The span the menu applies has to reach the end of the last week with commits.
  const span = weeksLib.weekSpan({
    firstWeek: Number(byLogin.get("claude").first_week),
    lastWeek: Number(byLogin.get("claude").last_week),
  });
  T(
    "the applied span covers the whole of the last week",
    span.from === W * 1000 && span.to === (W2 + 604800) * 1000 - 1,
    `${new Date(span.from).toISOString()} to ${new Date(span.to).toISOString()}`,
  );
}

/* ── Per-contributor repositories, for the card action ─────────────────────── */

// This one has to see past the current selection, since selecting a wider set is
// the whole point of it.
{
  const rows = await q.contributorRepoIds(db);
  const byLogin = new Map();
  for (const r of rows) {
    const key = r.login.toLowerCase();
    byLogin.set(key, [...(byLogin.get(key) ?? []), Number(r.repo_id)]);
  }

  T(
    "casings merge, so one person is one entry",
    byLogin.size === 3,
    [...byLogin.keys()].join(", "),
  );
  T(
    "a contributor spanning two repositories gets both",
    byLogin.get("claude").sort().join(",") === "1,2",
    JSON.stringify(byLogin.get("claude")),
  );
  T(
    "a contributor is listed under every repository they touched",
    byLogin.get("adampeterhiggins").sort().join(",") === "1,2",
    JSON.stringify(byLogin.get("adampeterhiggins")),
  );
  T(
    "someoneelse is in the two repositories they committed to",
    byLogin.get("someoneelse").sort().join(",") === "1,3",
    JSON.stringify(byLogin.get("someoneelse")),
  );
  T("no repository is listed twice for one person",
    [...byLogin.values()].every((ids) => new Set(ids).size === ids.length));

  // A row referencing a repository that is no longer in the cache must not come
  // back as something to select: the selection has a foreign key to repos.
  sqlite.exec(
    `INSERT INTO contributor_weeks (repo_id,login,week,commits,additions,deletions)
     VALUES (999,'claude',${W},5,5,5)`,
  );
  const after = await q.contributorRepoIds(db);
  T(
    "a repository missing from the cache is left out",
    after.every((r) => Number(r.repo_id) !== 999),
    after.filter((r) => Number(r.repo_id) === 999).length + " dangling rows",
  );
  sqlite.exec("DELETE FROM contributor_weeks WHERE repo_id = 999");
}

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
T("incremental mode does not use resume's terminal-status shortcut", !shouldSkip("ok", "incremental"));

/* Incremental refresh decisions */
const quietRepo = {
  pushed_at: "2026-08-10T00:00:00Z",
  updated_at: "2026-08-10T00:00:00Z",
};
const changedRepo = {
  pushed_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
};
const okCheckpoint = {
  status: "ok",
  lastOkAt: "2026-08-11T00:00:00Z",
  lastAttemptAt: "2026-08-11T00:00:00Z",
};
T(
  "incremental stats skip a repository with no pushes since its checkpoint",
  !sync.shouldFetchIncrementally("contributors", okCheckpoint, quietRepo),
);
T(
  "incremental stats refresh a repository pushed since its checkpoint",
  sync.shouldFetchIncrementally("contributors", okCheckpoint, changedRepo),
);
T(
  "incremental metadata refreshes after the repository update timestamp",
  sync.shouldFetchIncrementally("community", okCheckpoint, changedRepo),
);
T(
  "incremental traffic, Actions and pulse are sampled on every run",
  ["traffic", "actions", "pulse"].every((e) =>
    sync.shouldFetchIncrementally(e, okCheckpoint, quietRepo)),
);
T(
  "incremental refresh retries failed work",
  sync.shouldFetchIncrementally(
    "contributors",
    { ...okCheckpoint, status: "error" },
    quietRepo,
  ),
);
T(
  "incremental refresh leaves forbidden work for an explicit full sync",
  !sync.shouldFetchIncrementally(
    "contributors",
    { ...okCheckpoint, status: "forbidden" },
    changedRepo,
  ),
);
T(
  "incremental refresh fetches never-recorded work",
  sync.shouldFetchIncrementally("contributors", undefined, quietRepo),
);
T(
  "incremental cutoff starts ten minutes before the endpoint checkpoint",
  sync.incrementalSince("2026-08-11T12:00:00Z", 365) === "2026-08-11T11:50:00.000Z",
);
T(
  "first-sync cutoff falls back to the configured history window",
  sync.incrementalSince(null, 2, Date.parse("2026-08-11T12:00:00Z")) ===
    "2026-08-09T12:00:00.000Z",
);

/* ── Saved selections ─────────────────────────────────────────────────────── */

{
  await q.saveFilter(db, "repos", "Core services", [1, 2]);
  await q.saveFilter(db, "contributors", "Platform team", ["claude", "adampeterhiggins"]);

  let saved = await q.listSavedFilters(db);
  T("saved selections round-trip", saved.length === 2);
  T(
    "values decode to the right types",
    saved.find((f) => f.kind === "repos").values.every((v) => typeof v === "number") &&
      saved.find((f) => f.kind === "contributors").values.every((v) => typeof v === "string"),
  );
  T("listing can be scoped to one kind", (await q.listSavedFilters(db, "repos")).length === 1);

  // Saving over a name updates rather than creating a near-identical twin.
  await q.saveFilter(db, "repos", "Core services", [1, 2, 3]);
  saved = await q.listSavedFilters(db, "repos");
  T(
    "saving over an existing name replaces it",
    saved.length === 1 && saved[0].values.length === 3,
    `count=${saved.length} values=${saved[0]?.values.length}`,
  );

  // The same name under the other kind is a different selection.
  await q.saveFilter(db, "contributors", "Core services", ["someoneelse"]);
  T("the same name may exist per kind", (await q.listSavedFilters(db)).length === 3);

  const repoFilter = (await q.listSavedFilters(db, "repos"))[0];
  await q.renameSavedFilter(db, repoFilter.id, "  Core platform  ");
  T(
    "renaming trims whitespace",
    (await q.listSavedFilters(db, "repos"))[0].name === "Core platform",
  );

  await q.updateSavedFilterValues(db, repoFilter.id, [3]);
  T("values can be replaced in place", (await q.listSavedFilters(db, "repos"))[0].values.length === 1);

  let threw = false;
  try {
    await q.saveFilter(db, "repos", "   ", [1]);
  } catch {
    threw = true;
  }
  T("an empty name is rejected", threw);

  // A malformed payload must not take the whole list down with it.
  sqlite.exec(
    "INSERT INTO saved_filters (kind, name, payload) VALUES ('repos', 'broken', 'not json')",
  );
  const withBroken = await q.listSavedFilters(db, "repos");
  T(
    "a malformed payload degrades to empty rather than throwing",
    withBroken.length === 2 && withBroken.find((f) => f.name === "broken").values.length === 0,
  );

  await q.deleteSavedFilter(db, repoFilter.id);
  T("deleting removes just that one", (await q.listSavedFilters(db, "repos")).length === 1);
}

/* ── Filter dropdown data ─────────────────────────────────────────────────── */

// The dropdowns show period figures and hide people with none, but must still
// LIST someone quiet — otherwise they could never be selected to look at their
// history, which is the one thing you would open the filter to do.
{
  // W2 only: 'someoneelse' committed in W and not W2.
  const windowed = await q.listContributors(db, IDS, W2, W2);
  const quiet = windowed.find((c) => c.login === "someoneelse");
  T("a contributor with no commits in the period is still listed", quiet !== undefined);
  T("their period commits are zero", quiet && Number(quiet.commits) === 0, `commits=${quiet?.commits}`);
  T(
    "but their all-time total is retained so they can be found",
    quiet && Number(quiet.commits_all) === 3,
    `all=${quiet?.commits_all}`,
  );

  const active = windowed.find((c) => c.login.toLowerCase() === "claude");
  T("period commits reflect the window, not all time", active && Number(active.commits) === 7,
    `period=${active?.commits} all=${active?.commits_all}`);
  T("all-time still available alongside", active && Number(active.commits_all) === 17);
  T(
    "repos counts distinct repositories touched in the window",
    active && Number(active.repos) === 1,
    `repos=${active?.repos}`,
  );

  // Unbounded call must behave exactly as before.
  const unbounded = await q.listContributors(db, IDS);
  T(
    "omitting the period aggregates over all time",
    unbounded.find((c) => c.login.toLowerCase() === "claude").commits === 17,
  );

  // Repository counts for the repo dropdown come from the same period scoping.
  const repoTotals = await q.commitsByRepo(db, IDS, W2, W2);
  T(
    "repository totals are period-scoped too",
    repoTotals.length === 1 && Number(repoTotals[0].commits) === 10,
    `rows=${repoTotals.length}`,
  );
}

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

/* ── Timeline reshaping ───────────────────────────────────────────────────── */

// Both of these still draw a plausible curve when wrong, so they are checked
// directly: a cumulative series that dips, or a roll-up that loses a bucket, looks
// like data rather than a bug.
{
  const { rollUp, toCumulative, bucketStart } = series;
  const WEEK = 604800;
  // 10 consecutive weeks from 5 Jan 2026 (a Monday-ish anchor is irrelevant; the
  // function keys off the week start it is given).
  const first = Math.floor(Date.UTC(2026, 0, 4) / 1000);
  const rows = Array.from({ length: 10 }, (_, i) => ({ week: first + i * WEEK, a: i + 1, b: 1 }));

  const cum = toCumulative(rows, ["a", "b"]);
  T("cumulative ends at the sum", cum[9].a === 55 && cum[9].b === 10, `a=${cum[9].a} b=${cum[9].b}`);
  T("cumulative never decreases", cum.every((r, i) => i === 0 || r.a >= cum[i - 1].a));
  T("cumulative keeps the same number of rows", cum.length === rows.length);

  // A gap must plateau, not drop to zero.
  const gapped = [
    { week: first, a: 5 },
    { week: first + WEEK, a: 0 },
    { week: first + 2 * WEEK, a: 3 },
  ];
  const gapCum = toCumulative(gapped, ["a"]);
  T(
    "a quiet bucket plateaus rather than dropping",
    gapCum[1].a === 5 && gapCum[2].a === 8,
    gapCum.map((r) => r.a).join(","),
  );

  // Roll-up must conserve totals and reduce bucket count.
  const monthly = rollUp(rows, ["a", "b"], "month");
  const sumOf = (rs, k) => rs.reduce((acc, r) => acc + r[k], 0);
  T("monthly roll-up conserves the total", sumOf(monthly, "a") === 55, `got ${sumOf(monthly, "a")}`);
  T("monthly roll-up reduces bucket count", monthly.length < rows.length && monthly.length >= 2,
    `buckets=${monthly.length}`);
  T("roll-up output is ordered by time", monthly.every((r, i) => i === 0 || r.week > monthly[i - 1].week));

  const quarterly = rollUp(rows, ["a", "b"], "quarter");
  T("quarterly conserves the total too", sumOf(quarterly, "a") === 55);
  T("quarterly buckets are fewer than monthly", quarterly.length <= monthly.length);

  T("weekly roll-up is a no-op", rollUp(rows, ["a"], "week") === rows);

  // Bucket keys must be real month/quarter starts, or the axis lies.
  const jan = bucketStart(Math.floor(Date.UTC(2026, 0, 20) / 1000), "month");
  T("month buckets anchor to the first of the month",
    new Date(jan * 1000).toISOString().startsWith("2026-01-01"), new Date(jan * 1000).toISOString());
  const q = bucketStart(Math.floor(Date.UTC(2026, 4, 20) / 1000), "quarter");
  T("quarter buckets anchor to the quarter start",
    new Date(q * 1000).toISOString().startsWith("2026-04-01"), new Date(q * 1000).toISOString());

  // Order of operations matters: rolling up then accumulating must equal
  // accumulating then sampling at bucket ends.
  const rolledThenCum = toCumulative(rollUp(rows, ["a"], "month"), ["a"]);
  T(
    "roll-up then cumulative reaches the same grand total",
    rolledThenCum[rolledThenCum.length - 1].a === 55,
  );

  /* Brush window mapping. A wrong answer here zooms the cards to the wrong dates
     while still looking like a legitimate window, so each case is pinned. */
  const { weekWindow } = series;
  const weeks = rows.map((r) => r.week);

  T(
    "weekly buckets map straight through",
    JSON.stringify(weekWindow(rows, weeks, 2, 5)) === JSON.stringify({ start: 2, end: 5 }),
    JSON.stringify(weekWindow(rows, weeks, 2, 5)),
  );

  // 10 weeks from 4 Jan 2026 span January, February and (one week of) March.
  T("monthly roll-up gives three buckets here", monthly.length === 3, `got ${monthly.length}`);
  const janOnly = weekWindow(monthly, weeks, 0, 0);
  T(
    "one monthly bucket selects only that month's weeks",
    weeks.slice(janOnly.start, janOnly.end + 1).every((w) => new Date(w * 1000).getUTCMonth() === 0),
    JSON.stringify(janOnly),
  );
  T("a month window starts at the first week", janOnly.start === 0, JSON.stringify(janOnly));

  const febOn = weekWindow(monthly, weeks, 1, 2);
  T(
    "a window ending at the last bucket reaches the final week",
    febOn.end === weeks.length - 1,
    JSON.stringify(febOn),
  );
  T(
    "consecutive bucket windows meet without a gap or overlap",
    febOn.start === janOnly.end + 1,
    `${JSON.stringify(janOnly)} then ${JSON.stringify(febOn)}`,
  );

  T("the whole range maps to every week",
    JSON.stringify(weekWindow(monthly, weeks, 0, monthly.length - 1)) ===
      JSON.stringify({ start: 0, end: weeks.length - 1 }));

  // Rows covering a slice of the axis still resolve against the whole axis, which
  // is what happens when a breakdown redraws the chart over an existing window.
  const tail = weekWindow(rows.slice(6), weeks, 0, 1);
  T("a sliced chart still maps onto the full axis",
    JSON.stringify(tail) === JSON.stringify({ start: 6, end: 7 }), JSON.stringify(tail));

  T("a stale index yields no window", weekWindow(monthly, weeks, 99, 99) === null);
  T("an empty chart yields no window", weekWindow([], weeks, 0, 0) === null);
}

/* ── Bot detection ─────────────────────────────────────────────────────────── */

// A false positive here removes a colleague from every chart on every page, so the
// built-ins are pinned against names that only look like automation.
{
  const bots = await bundle("src/lib/bots.ts", "bots.cjs");
  const { isBot, botLogins, matchesPattern } = bots;

  for (const login of [
    "dependabot[bot]",
    "github-actions[bot]",
    "renovate[bot]",
    "my-release-bot",
    "some_bot",
    "bot-runner",
    "dependabot-preview",
    "snyk-bot",
    "imgbot",
    "web-flow",
  ]) {
    T(`${login} is detected`, isBot(login) === true);
  }

  // Real logins that share a substring with automation, or are simply people.
  for (const login of [
    "adampeterhiggins",
    "botticelli",
    "abbott",
    "robotnik",
    "elliot",
    "sbotond",
  ]) {
    T(`${login} is left alone`, isBot(login) === false);
  }

  T("detection ignores casing", isBot("Dependabot[BOT]") === true);

  // AI agents are deliberately not built in: every one of those names is also a
  // person's username, and the user's list is where that judgement belongs.
  T("agents are not guessed at", isBot("claude") === false && isBot("codex") === false);
  T("a user pattern picks them up", isBot("claude", ["claude"]) === true);
  T("a user glob works too", isBot("claude-code-agent", ["claude*"]) === true);
  T(
    "a user pattern does not widen the built-ins",
    isBot("abbott", ["claude"]) === false,
  );

  T(
    "botLogins returns just the automation",
    botLogins(["adampeterhiggins", "dependabot[bot]", "claude"], ["claude"]).join(",") ===
      "dependabot[bot],claude",
  );

  // The pattern language: `*` spans anything, everything else is literal.
  T("a bare pattern is an exact match", matchesPattern("claude", "claude") === true);
  T("a bare pattern is not a substring match", matchesPattern("claudette", "claude") === false);
  T("a trailing star matches a prefix", matchesPattern("claudette", "claude*") === true);
  T("regex characters in a pattern are literal", matchesPattern("a+b", "a+b") === true);
  T("an empty pattern matches nothing", matchesPattern("anyone", "  ") === false);
}

/* ── Contribution metrics ─────────────────────────────────────────────────── */

{
  const { metricValue, metricCanBeNegative, METRICS } = metrics;
  // SQLite hands big integers back as strings, and the cache has gaps.
  const row = { commits: 12, additions: "5000", deletions: 1200 };

  T("a stored metric reads its own column", metricValue(row, "commits") === 12);
  T("a string column is still a number", metricValue(row, "additions") === 5000);
  T("net is additions minus deletions", metricValue(row, "net") === 3800);
  T(
    "net goes negative when more was removed than added",
    metricValue({ additions: 10, deletions: 400 }, "net") === -390,
  );
  T("a missing column reads as zero, not NaN", metricValue({ commits: 1 }, "net") === 0);
  T("no row at all reads as zero", metricValue(null, "commits") === 0);
  T("only net is signed",
    metricCanBeNegative("net") === true && METRICS.filter((m) => metricCanBeNegative(m.id)).length === 1);
}

/* ── Signed shares, for the normalised view ───────────────────────────────── */

// The divisor is the point that matters: a mixed row's signed sum is nowhere near
// the movement it actually contains, and dividing by it reports shares over 100%.
{
  const { toShares } = series;
  const at = (rows, i, k) => Number(rows[i][k].toFixed(4));

  const positive = toShares([{ week: 1, a: 100, b: 500 }], ["a", "b"]);
  T("shares of a positive row sum to one",
    at(positive, 0, "a") === 0.1667 && at(positive, 0, "b") === 0.8333,
    JSON.stringify(positive[0]));

  const mixed = toShares([{ week: 1, a: 300, b: -400 }], ["a", "b"]);
  T("a mixed row divides by the churn, not the signed sum",
    at(mixed, 0, "a") === 0.4286 && at(mixed, 0, "b") === -0.5714,
    JSON.stringify(mixed[0]));
  T("mixed shares still fill one unit of axis",
    Math.abs(mixed[0].a) + Math.abs(mixed[0].b) === 1);

  const allNegative = toShares([{ week: 1, a: -200, b: -600 }], ["a", "b"]);
  T("an all-negative row sits entirely below the baseline",
    at(allNegative, 0, "a") === -0.25 && at(allNegative, 0, "b") === -0.75,
    JSON.stringify(allNegative[0]));

  // The signed sum is zero here: dividing by it would be a division by zero, and
  // the shares are still perfectly well defined.
  const cancelling = toShares([{ week: 1, a: 500, b: -500 }], ["a", "b"]);
  T("a row that cancels out still has shares",
    at(cancelling, 0, "a") === 0.5 && at(cancelling, 0, "b") === -0.5,
    JSON.stringify(cancelling[0]));

  const empty = toShares([{ week: 1, a: 0, b: 0 }], ["a", "b"]);
  T("an empty row stays at zero rather than dividing by it",
    empty[0].a === 0 && empty[0].b === 0);

  T("keys outside the series list are left alone",
    toShares([{ week: 7, a: 10 }], ["a"])[0].week === 7);
}

/* ── Shared y bounds across small multiples ───────────────────────────────── */

// The failure here is silent: a floor of zero draws a week that deleted 5,000
// lines as nothing, and the card still looks like a chart.
{
  const { chartBounds } = series;
  const chart = (keys, rows) => ({ keys, data: rows });

  const positive = [chart(["a"], [{ week: 1, a: 40 }]), chart(["a"], [{ week: 1, a: 120 }])];
  T(
    "positive charts keep a zero floor",
    JSON.stringify(chartBounds(positive, true)) === JSON.stringify({ floor: 0, ceiling: 120 }),
    JSON.stringify(chartBounds(positive, true)),
  );

  const signed = [
    chart(["a"], [{ week: 1, a: 200 }, { week: 2, a: -5000 }]),
    chart(["a"], [{ week: 1, a: 80 }]),
  ];
  T(
    "a negative week pushes the floor below zero",
    JSON.stringify(chartBounds(signed, true)) === JSON.stringify({ floor: -5000, ceiling: 200 }),
    JSON.stringify(chartBounds(signed, true)),
  );

  // Mixed signs in one row: stacked bands grow in both directions at once, and
  // summing them against each other would understate both ends.
  const mixed = [chart(["a", "b"], [{ week: 1, a: 300, b: -400 }])];
  T(
    "stacked mixed signs measure each direction separately",
    JSON.stringify(chartBounds(mixed, true)) === JSON.stringify({ floor: -400, ceiling: 300 }),
    JSON.stringify(chartBounds(mixed, true)),
  );
  T(
    "overlaid mixed signs take the extremes, not the sums",
    JSON.stringify(chartBounds([chart(["a", "b"], [{ week: 1, a: 300, b: 500 }])], false)) ===
      JSON.stringify({ floor: 0, ceiling: 500 }),
    JSON.stringify(chartBounds([chart(["a", "b"], [{ week: 1, a: 300, b: 500 }])], false)),
  );
  T(
    "stacked positives do sum",
    chartBounds([chart(["a", "b"], [{ week: 1, a: 300, b: 500 }])], true).ceiling === 800,
  );

  T("an empty set still has a scale to draw against",
    JSON.stringify(chartBounds([], true)) === JSON.stringify({ floor: 0, ceiling: 1 }));
}

/* ── How many series are drawn before "Other" ─────────────────────────────── */

// The band has to keep totalling the same whatever the limit, or the chart changes
// its story depending on how many colours it was allowed.
{
  const entities = Array.from({ length: 12 }, (_, i) => ({
    k: `repo-${String(i).padStart(2, "0")}`,
    w: W,
    v: 1200 - i * 100,
  }));
  const input = {
    rows: entities,
    weeks: [W],
    weekOf: (r) => r.w,
    keyOf: (r) => r.k,
    labelOf: (r) => r.k,
    valueOf: (r) => r.v,
  };
  const grandTotal = entities.reduce((a, e) => a + e.v, 0);
  const drawn = (result) => result.series.reduce((a, s) => a + s.total, 0);

  const four = stacks.buildStacks({ ...input, maxSeries: 4 });
  T("a limit of four draws four plus Other", four.series.length === 5, `${four.series.length} series`);
  T("the folded count says how many went in", four.foldedCount === 8, `${four.foldedCount} folded`);
  T("folding conserves the total", drawn(four) === grandTotal, `${drawn(four)} of ${grandTotal}`);

  const eight = stacks.buildStacks({ ...input, maxSeries: 8 });
  T("the default eight leaves four in Other", eight.foldedCount === 4, `${eight.foldedCount} folded`);
  T("eight also conserves the total", drawn(eight) === grandTotal);

  // "All": no Other band at all, and every entity keeps its own slot number so the
  // chart can colour them — repeating hues past the eighth, deliberately.
  const all = stacks.buildStacks({ ...input, maxSeries: Number.POSITIVE_INFINITY });
  T("showing all draws every entity", all.series.length === 12, `${all.series.length} series`);
  T("showing all folds nothing", all.foldedCount === 0);
  T("no Other band exists when nothing is folded",
    all.series.every((s) => s.slot !== null));
  T("showing all conserves the total too", drawn(all) === grandTotal);
  T(
    "slots keep counting past the palette's eight",
    all.series[8].slot === 8 && all.series[11].slot === 11,
    all.series.map((s) => s.slot).join(","),
  );

  // Fewer entities than the limit must not invent an empty Other band.
  const few = stacks.buildStacks({
    ...input,
    rows: entities.slice(0, 3),
    maxSeries: 8,
  });
  T("a short list has no Other band", few.series.length === 3 && few.foldedCount === 0);
}

/* ── Slot ranking for a signed metric ─────────────────────────────────────── */

// Under net lines, the repository that deleted the most is as interesting as the
// one that added the most; ranking by the signed total buries it in "Other".
{
  const rows = [
    { k: "adds-a-lot", w: W, v: 900 },
    { k: "adds-some", w: W, v: 500 },
    { k: "deletes-a-lot", w: W, v: -8000 },
  ];
  const input = {
    rows,
    weeks: [W],
    weekOf: (r) => r.w,
    keyOf: (r) => r.k,
    labelOf: (r) => r.k,
    valueOf: (r) => r.v,
    maxSeries: 2,
  };

  const signed = stacks.buildStacks(input);
  T(
    "by signed total, the big deletion folds away",
    signed.series.map((s) => s.key).join(",") === "adds-a-lot,adds-some,__other__",
    signed.series.map((s) => s.key).join(","),
  );

  const byMagnitude = stacks.buildStacks({ ...input, rankBy: Math.abs });
  T(
    "by magnitude, the big deletion takes a slot",
    byMagnitude.series.map((s) => s.key).join(",") === "deletes-a-lot,adds-a-lot,__other__",
    byMagnitude.series.map((s) => s.key).join(","),
  );
  T(
    "folding still sums the signed totals",
    byMagnitude.series.find((s) => s.key === "__other__").total === 500,
  );
}

/* ── Period resolution ────────────────────────────────────────────────────── */

// A wrong range here dates every number on the page while still looking entirely
// reasonable, so the custom bounds and the presets are pinned against each other.
{
  const { resolvePeriod, parseDayInput } = weeksLib;
  const now = new Date("2026-08-12T09:30:00Z");
  const jan1 = Date.UTC(2026, 0, 1);
  const mar15End = Date.UTC(2026, 2, 15, 23, 59, 59, 999);

  const custom = resolvePeriod("custom", { now, customFrom: jan1, customTo: mar15End });
  T("a custom period uses both bounds",
    custom.fromMs === jan1 && custom.toMs === mar15End,
    new Date(custom.fromMs).toISOString() + " to " + new Date(custom.toMs).toISOString());

  // The dates are remembered while a preset is selected; a preset must ignore them.
  const week = resolvePeriod("1w", { now, customFrom: jan1, customTo: mar15End });
  T("a preset ends now, not at a remembered custom end",
    week.toMs === now.getTime(),
    new Date(week.toMs).toISOString());
  T("a preset starts its own span back from now",
    week.fromMs === now.getTime() - 7 * 86_400_000,
    new Date(week.fromMs).toISOString());

  const ytd = resolvePeriod("ytd", { now, customFrom: jan1, customTo: mar15End });
  T("year to date still starts on 1 January",
    new Date(ytd.fromMs).toISOString().startsWith("2026-01-01") && ytd.toMs === now.getTime());

  const all = resolvePeriod("all", { now, customTo: mar15End });
  T("all time still ends now", all.toMs === now.getTime() && all.fromMs === 0);

  // "custom" with no dates must not silently claim a bound it does not have.
  const bare = resolvePeriod("custom", { now });
  T("custom without dates falls back to a span ending now", bare.toMs === now.getTime());

  T("a date input parses as UTC midnight", parseDayInput("2026-01-01") === jan1);
  T("an end date parses as the last millisecond of the day",
    parseDayInput("2026-03-15", true) === mar15End);
  T("a half-typed date is not a date", parseDayInput("2026-03") === null);
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

/* ── Pre-sync commit counts ───────────────────────────────────────────────── */

// These are what the sync targets get chosen from, so "unreadable" has to stay
// distinguishable from "read it, there is nothing there" all the way to the table.
{
  const since = "2026-01-01T00:00:00.000Z";
  await q.saveRepoStats(db, [
    { repoId: 1, commits: 4200, recentCommits: 130, since, readable: true },
    { repoId: 2, commits: 0, recentCommits: 0, since, readable: true },
    { repoId: 3, commits: null, recentCommits: null, since, readable: false },
  ]);

  const rows = await q.getRepoStats(db);
  const byId = new Map(rows.map((r) => [r.repo_id, r]));
  T("pre-sync counts round-trip", rows.length === 3, `${rows.length} rows`);
  T(
    "a counted repository keeps both figures",
    Number(byId.get(1).commits) === 4200 && Number(byId.get(1).recent_commits) === 130,
    JSON.stringify(byId.get(1)),
  );
  T(
    "an empty repository is zero, not unknown",
    byId.get(2).commits === 0 && byId.get(2).readable === 1,
    JSON.stringify(byId.get(2)),
  );
  T(
    "an unreadable repository is null, not zero",
    byId.get(3).commits === null && byId.get(3).readable === 0,
    JSON.stringify(byId.get(3)),
  );
  T("the window is recorded alongside the count", byId.get(1).since === since);
  T("every row is stamped", rows.every((r) => typeof r.checked_at === "string"));

  // Re-counting must correct a row rather than add a second one for the same repo.
  await q.saveRepoStats(db, [
    { repoId: 1, commits: 4300, recentCommits: 230, since, readable: true },
  ]);
  const after = await q.getRepoStats(db);
  T(
    "re-counting updates in place",
    after.length === 3 && Number(after.find((r) => r.repo_id === 1).commits) === 4300,
    `${after.length} rows`,
  );
}

/* ── The pre-sync sweep, against a fake GitHub ────────────────────────────── */

/*
 * Driven through the real client, so the Link rel="last" trick the whole feature
 * rests on is exercised rather than assumed. What is being checked is the request
 * accounting: the point of a pre-sync is that it costs far less than a sync, and an
 * extra request per repository would quietly undo that.
 */
{
  const presync = await bundle("src/lib/ingest/presync.ts", "presync.cjs");

  const requests = [];
  const reply = (body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });

  globalThis.__ghFetch = async (url) => {
    const path = String(url);
    requests.push(path);
    // o/a: 1,204 commits, 12 of them inside the window.
    if (path.includes("/repos/o/a/commits")) {
      const page = path.includes("since=") ? 12 : 1204;
      return reply([{}], {
        link: `<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=${page}>; rel="last"`,
      });
    }
    // o/b: readable, single page, no commits at all.
    if (path.includes("/repos/o/b/commits")) return reply([]);
    // o/c: no access.
    if (path.includes("/repos/o/c/commits")) {
      return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "4999" } });
    }
    throw new Error(`unexpected request: ${path}`);
  };

  sqlite.exec("DELETE FROM repo_stats");
  const repos = [
    { id: 1, owner: "o", name: "a", full_name: "o/a" },
    { id: 2, owner: "o", name: "b", full_name: "o/b" },
    { id: 3, owner: "o", name: "c", full_name: "o/c" },
  ];
  const progress = [];
  const result = await presync.runPreSync({
    db,
    token: "t",
    repos,
    sinceDays: 365,
    onProgress: (p) => progress.push({ ...p }),
  });

  T(
    "the Link rel=last page number is the commit count",
    result.stats.get(1).commits === 1204 && result.stats.get(1).recentCommits === 12,
    JSON.stringify(result.stats.get(1)),
  );
  T(
    "a readable repository with no commits counts zero",
    result.stats.get(2).commits === 0 && result.stats.get(2).recentCommits === 0,
    JSON.stringify(result.stats.get(2)),
  );
  T("an inaccessible repository is reported unreadable", result.unreadable.includes(3));

  // Two per countable repository, one for the unreadable one: asking it again for a
  // window it cannot show us would be a wasted request.
  T(
    "an unreadable repository costs one request, not two",
    result.requestsMade === 5,
    `${result.requestsMade} requests for ${repos.length} repositories`,
  );
  T(
    "the window is applied to the recent count only",
    requests.filter((r) => r.includes("since=")).length === 2,
    requests.filter((r) => r.includes("since=")).length + " windowed requests",
  );
  T("every request asks for a single item", requests.every((r) => r.includes("per_page=1")));

  const persisted = await q.getRepoStats(db);
  T(
    "the sweep persists what it found, unreadable rows included",
    persisted.length === 3 &&
      Number(persisted.find((r) => r.repo_id === 1).commits) === 1204 &&
      persisted.find((r) => r.repo_id === 3).readable === 0,
    JSON.stringify(persisted.map((r) => [r.repo_id, r.commits, r.readable])),
  );
  T("progress is reported for every repository", progress.at(-1).done === 3);

  // A sweep stopped part way must still leave behind what it managed to learn.
  sqlite.exec("DELETE FROM repo_stats");
  const controller = new AbortController();
  const partial = await presync.runPreSync({
    db,
    token: "t",
    repos,
    onProgress: (p) => {
      if (p.done >= 1) controller.abort();
    },
    signal: controller.signal,
  });
  T("a cancelled sweep says so", partial.cancelled === true);
  T(
    "a cancelled sweep still persists its partial results",
    (await q.getRepoStats(db)).length >= 1,
    `${(await q.getRepoStats(db)).length} rows`,
  );

  delete globalThis.__ghFetch;
}

/* ── Concentration (bus factor) ───────────────────────────────────────────── */

{
  const empty = concentration.concentration([]);
  T("an empty bag of counts is all zeroes", empty.total === 0 && empty.top1 === 0 && empty.contributors === 0);

  const one = concentration.concentration([10]);
  T("a single person holds the lot", one.top1 === 1 && one.top3 === 1 && one.contributors === 1);

  const split = concentration.concentration([50, 30, 10, 10]);
  T(
    "top-K shares are of the positive total",
    split.top1 === 0.5 && split.top3 === 0.9 && split.top5 === 1 && split.contributors === 4,
    JSON.stringify(split),
  );
  T("zero counts do not count as people", concentration.concentration([8, 0, 2]).contributors === 2);

  const units = concentration.allocateUnits([50, 30, 20], 100);
  T("a clean split allocates exactly", units.join(",") === "50,30,20");
  T(
    "leftover cells go to the largest remainders and still sum",
    concentration.allocateUnits([1, 1, 1], 10).reduce((a, n) => a + n, 0) === 10,
  );
  T("a zero total does not invent a uniform split", concentration.allocateUnits([0, 0], 100).join(",") === "0,0");
  T("a zero weight stays zero", concentration.allocateUnits([10, 0], 7)[1] === 0);
}

/* ── Ownership matrix ─────────────────────────────────────────────────────── */

{
  const cells = await q.ownershipCells(db, IDS, 0, W2 + 1);
  const claude = cells.filter((r) => r.login.toLowerCase() === "claude");
  T(
    "ownership merges login casings into one person per repository",
    claude.length === 2 && claude.reduce((a, r) => a + Number(r.commits), 0) === 17,
    claude.map((r) => `${r.full_name}:${r.commits}`).join(", "),
  );
  T(
    "ownership honours the contributor filter, casing and all",
    (await q.ownershipCells(db, IDS, 0, W2 + 1, ["CLAUDE"])).every(
      (r) => r.login.toLowerCase() === "claude",
    ),
  );
  T("no repositories selected yields no ownership cells", (await q.ownershipCells(db, [], 0, W2 + 1)).length === 0);
  T(
    "a week with no commits is dropped from the matrix",
    (await q.ownershipCells(db, IDS, W2 + 604800, W2 + 604800 * 2)).length === 0,
  );
}

/* ── PR scatter ───────────────────────────────────────────────────────────── */

sqlite.exec(`UPDATE pull_requests SET additions = 40, deletions = 10, comments = 2, reviews = 1 WHERE number = 1`);
sqlite.exec(`INSERT INTO pull_requests (repo_id,number,author,title,state,created_at,merged_at,additions,deletions,comments,reviews)
  VALUES (2,3,'adampeterhiggins','z','MERGED','2026-05-02T00:00:00Z','2026-05-04T12:00:00Z',200,50,0,0)`);

{
  const points = await q.mergedPrScatter(db, IDS, "2026-05-01T00:00:00Z", "2026-05-10T00:00:00Z");
  T("scatter includes every merged PR in the window", points.length === 2, `${points.length} points`);
  const claude = points.find((p) => p.author === "claude");
  T(
    "scatter hours are created-to-merged, and size is stored not summed here",
    claude && Number(claude.hours) === 24 && Number(claude.additions) === 40 && Number(claude.deletions) === 10,
    JSON.stringify(claude),
  );
  T(
    "scatter respects the contributor filter",
    (await q.mergedPrScatter(db, IDS, "2026-05-01T00:00:00Z", "2026-05-10T00:00:00Z", ["claude"])).length === 1,
  );
  T(
    "an open PR is not a scatter point",
    points.every((p) => p.number !== 2),
  );
}

/* ── Roster (arrivals, last-seen, repos left cold) ───────────────────────── */

{
  const all = await q.rosterRows(db, IDS, W, W2);
  const byLogin = new Map(all.map((r) => [r.login.toLowerCase(), r]));
  T("roster merges login casings into one person", all.length === 3, `${all.length} rows`);
  T(
    "first and last week span every week with commits",
    Number(byLogin.get("claude").first_week) === W && Number(byLogin.get("claude").last_week) === W2,
    JSON.stringify(byLogin.get("claude")),
  );

  const late = await q.rosterRows(db, IDS, W2, W2);
  const lateBy = new Map(late.map((r) => [r.login.toLowerCase(), r]));
  T(
    "a person with no commits in the window is still listed, with zero period commits",
    Number(lateBy.get("someoneelse").commits) === 0 && Number(lateBy.get("someoneelse").last_week) === W,
    JSON.stringify(lateBy.get("someoneelse")),
  );
  T(
    "someoneelse left o/c cold — they were the only committer in its last week",
    Number(lateBy.get("someoneelse").left_repos) === 1,
    JSON.stringify(lateBy.get("someoneelse")),
  );
  T(
    "a shared last week is not left cold",
    Number(lateBy.get("claude").left_repos) === 0,
    JSON.stringify(lateBy.get("claude")),
  );
  T(
    "roster honours the contributor filter, casing and all",
    (await q.rosterRows(db, IDS, W, W2, ["CLAUDE"])).every((r) => r.login.toLowerCase() === "claude"),
  );
  T("no repositories selected yields no roster", (await q.rosterRows(db, [], W, W2)).length === 0);
}

/* ── Open pull requests ───────────────────────────────────────────────────── */

{
  const open = await q.openPullRequests(db, IDS, "2026-05-11T00:00:00Z");
  T("open PRs exclude merged ones", open.length === 1 && Number(open[0].number) === 2, JSON.stringify(open));
  T(
    "age is created-to-asOf, so a pinned clock is testable",
    Number(open[0].age_hours) === 7 * 24,
    String(open[0].age_hours),
  );
  T(
    "open PRs honour the contributor filter",
    (await q.openPullRequests(db, IDS, "2026-05-11T00:00:00Z", ["someoneelse"])).length === 1,
  );
  T(
    "an asOf before the PR was opened excludes it",
    (await q.openPullRequests(db, IDS, "2026-05-03T00:00:00Z")).length === 0,
  );
  T("no repositories selected yields no open PRs", (await q.openPullRequests(db, [], "2026-05-11T00:00:00Z")).length === 0);
}

/* ── Referrer history ─────────────────────────────────────────────────────── */

sqlite.exec(`INSERT INTO traffic_referrers (repo_id,snapshot_day,referrer,count,uniques) VALUES
  (1,'2026-05-01','github.com',10,4),
  (1,'2026-05-08','github.com',6,3),
  (1,'2026-05-08','google.com',4,2),
  (2,'2026-05-08','github.com',5,2)`);

{
  const hist = await q.trafficReferrersOverTime(db, IDS, "2026-05-01", "2026-05-31");
  const days = [...new Set(hist.map((r) => r.day))];
  T("referrer history keeps every snapshot day, not just the latest", days.length === 2, days.join(","));
  const eighth = hist.filter((r) => r.day === "2026-05-08" && r.referrer === "github.com");
  T(
    "the same referrer on one day is summed across repositories",
    eighth.length === 1 && Number(eighth[0].count) === 11,
    JSON.stringify(eighth),
  );
  T(
    "a window that misses the snapshots is empty",
    (await q.trafficReferrersOverTime(db, IDS, "2026-06-01", "2026-06-30")).length === 0,
  );
}

/* ── Dependabot joined to drift ───────────────────────────────────────────── */

sqlite.exec(`INSERT INTO dependencies (repo_id,ecosystem,package,version) VALUES
  (1,'npm','lodash','4.17.20'),
  (2,'npm','lodash','4.17.21'),
  (1,'npm','left-pad','1.3.0')`);
sqlite.exec(`INSERT INTO dependabot_alerts (repo_id,number,severity,ecosystem,package,ghsa_id,summary,state,created_at) VALUES
  (1,1,'high','npm','lodash','GHSA-x','prototype pollution','open','2026-05-01'),
  (2,2,'low','npm','left-pad','GHSA-y','whatever','open','2026-05-02'),
  (3,3,'critical','npm','secret','GHSA-z','out of scope','open','2026-05-03')`);

{
  const rows = await q.dependabotAlertRows(db, [1, 2]);
  T("alerts outside the selected repositories are dropped", rows.every((r) => r.repo_id !== 3), `${rows.length} rows`);
  const lodash = rows.find((r) => r.package === "lodash");
  const left = rows.find((r) => r.package === "left-pad");
  T("a package pinned to two versions is marked drifting", Number(lodash?.drifting) === 1, JSON.stringify(lodash));
  T("a package on one version is not drifting", Number(left?.drifting) === 0, JSON.stringify(left));
  T(
    "severity order puts high before low",
    rows[0].package === "lodash" && rows[1].package === "left-pad",
    rows.map((r) => r.package).join(","),
  );
}

/* ── Clearing the cache must not lose user-authored content ───────────────── */

{
  const dbIndex = await bundle("src/lib/db/index.ts", "dbindex2.cjs");
  await q.saveFilter(db, "contributors", "Survives a wipe", ["claude"]);
  const before = (await q.listSavedFilters(db)).length;
  await dbIndex.clearAnalytics(db);
  const after = await q.listSavedFilters(db);
  T(
    "clearAnalytics leaves saved selections alone",
    after.length === before && after.some((f) => f.name === "Survives a wipe"),
    `before=${before} after=${after.length}`,
  );
  T(
    "clearAnalytics does wipe the analytics it is meant to",
    sqlite.prepare("SELECT count(*) n FROM contributor_weeks").get().n === 0,
  );
  // Wiping the cache is how you decide to re-sync, and these counts are what that
  // decision is made from — losing them would mean re-spending the requests first.
  T(
    "clearAnalytics keeps the pre-sync counts",
    sqlite.prepare("SELECT count(*) n FROM repo_stats").get().n === 3,
  );
}

console.log(failures === 0 ? "\nAll query tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
