#!/usr/bin/env node
/**
 * Line ownership benchmark on a COPY of real data.
 *
 *   cp ~/Library/Application\ Support/com.adamhiggins.github-monitor/github-monitor.db /tmp/gm-copy.db
 *   npm run bench:line-ownership -- /tmp/gm-copy.db [--runs 5] [--repos 1,2,3] [--baseline out.json] [--save out.json]
 *
 * Measures what Node can measure: SQL and JSON parse, identity resolution,
 * contributor selection, the daily sweep, period buckets and plotted points.
 * Paint and input-to-paint need the desktop app: run `npm run tauri dev` and read
 * the `ownership:*` and `render:ownership-history:*` measures in Web Inspector.
 * Git history timings come from the Rust benchmark:
 *   OWNERSHIP_BENCH_REPO=/path/to/clone cargo test --release --lib history_engine_benchmark -- --ignored --nocapture
 *
 * The copy may be migrated in place. The live application database is refused.
 * Output contains counts and timings only; checksums identify outputs without
 * printing names or emails. Keep copied databases and saved output out of Git.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, cpus, totalmem, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const path = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!path) {
  console.error("Usage: npm run bench:line-ownership -- <copied database> [--runs 5] [--repos 1,2] [--baseline file] [--save file]");
  process.exit(2);
}
const real = realpathSync(resolve(path));
const liveDir = join(homedir(), "Library", "Application Support", "com.adamhiggins.github-monitor");
let liveReal = null;
try { liveReal = realpathSync(liveDir); } catch { /* no live app data on this machine */ }
if (liveReal && (real === liveReal || real.startsWith(`${liveReal}/`))) {
  console.error("Refusing to benchmark the live application database. Copy it first:");
  console.error(`  cp "${join(liveDir, "github-monitor.db")}" /tmp/gm-copy.db`);
  process.exit(2);
}
const runs = Math.max(1, Number(flag("runs", "5")));

const work = mkdtempSync(join(tmpdir(), "gm-bench-"));
const sqlite = new DatabaseSync(real);
try {
  const output = join(work, "bench.cjs");
  const modules = ["src/lib/lineOwnership.ts", "src/lib/ownershipIdentity.ts", "src/lib/ownershipHistory.ts", "src/lib/db/lineOwnership.ts", "src/lib/db/index.ts"];
  await build({
    stdin: { contents: modules.map((m) => `export * from ${JSON.stringify(resolve(m))};`).join("\n"), resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "cjs", outfile: output, logLevel: "error",
    plugins: [{ name: "tauri-stub", setup(b) {
      b.onResolve({ filter: /^@tauri-apps\// }, (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default {}; export const invoke = () => { throw new Error('no tauri'); }; export class Channel {}" }));
    } }],
  });
  const lib = createRequire(import.meta.url)(output);
  const named = (params) => Object.fromEntries(params.map((v, i) => [String(i + 1), v ?? null]));
  let bytesRead = 0;
  const db = {
    select: async (sql, params = []) => {
      const rows = sqlite.prepare(sql).all(named(params));
      for (const row of rows) for (const value of Object.values(row)) if (typeof value === "string") bytesRead += value.length;
      return rows;
    },
    execute: async (sql, params = []) => ({ rowsAffected: Number(sqlite.prepare(sql).run(named(params)).changes) }),
  };
  await lib.migrate(db);

  const allIds = sqlite.prepare("SELECT repo_id FROM line_ownership").all().map((r) => r.repo_id);
  const repoIds = flag("repos") ? flag("repos").split(",").map(Number) : allIds;
  const stats = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return { median: +sorted[Math.floor(sorted.length / 2)].toFixed(2), min: +sorted[0].toFixed(2), max: +sorted.at(-1).toFixed(2) };
  };
  const timed = async (fn) => { const start = performance.now(); const value = await fn(); return [performance.now() - start, value]; };
  const samples = {};
  const note = (key, ms) => (samples[key] ??= []).push(ms);
  let result;
  for (let run = 0; run < runs; run++) {
    bytesRead = 0;
    const [revMs, revisions] = await timed(() => lib.ownershipRevisions(db, repoIds));
    note("query.revisions_ms", revMs);
    let reports = [];
    const reportStart = bytesRead;
    const [snapMs] = await timed(async () => { for (const r of revisions) if (r.hasReport) reports.push({ id: r.repoId, report: await lib.ownershipReport(db, r.repoId) }); });
    note("query.snapshot_ms", snapMs);
    const snapshotBytes = bytesRead - reportStart;
    reports = reports.filter((r) => r.report);
    const historyStart = bytesRead;
    const [historyMs, histories] = await timed(async () => {
      const out = [];
      for (const r of revisions) if (r.history.kind !== "none") out.push(await lib.ownershipDays(db, r.repoId, r.history));
      return out;
    });
    note("query.history_ms", historyMs);
    const historyBytes = bytesRead - historyStart;
    const [accountMs, accounts] = await timed(() => lib.ownershipAccountIndex(db));
    note("query.accounts_ms", accountMs);
    const [identityMs, identity] = await timed(() => lib.ownershipIdentity(reports.map((r) => r.report), accounts, reports.map((r) => r.id)));
    note("ui.snapshot_identity_ms", identityMs);
    const [summaryMs, summary] = await timed(() => lib.aggregateOwnership(reports.map((r) => r.report), "person", [], identity, reports.map((r) => r.id)));
    note("ui.summary_ms", summaryMs);
    const topLogins = summary.authors.filter((a) => a.matched).slice(0, 3).map((a) => a.login);
    const [selectMs, selected] = await timed(() => lib.aggregateOwnership(reports.map((r) => r.report), "person", topLogins, identity, reports.map((r) => r.id)));
    note("ui.selection_ms", selectMs);
    const [normalizeMs, normalized] = await timed(() => histories.map(lib.normalizeRepoHistory));
    note("ui.normalize_ms", normalizeMs);
    const [historyIdentityMs, historyIdentity] = await timed(() => lib.resolveOwnershipPeople(normalized, accounts));
    note("ui.history_identity_ms", historyIdentityMs);
    const [sweepMs, series] = await timed(() => lib.projectOwnershipHistory(normalized, historyIdentity, null, { limit: 8 }));
    note("ui.daily_sweep_ms", sweepMs);
    const [allMs] = await timed(() => lib.projectOwnershipHistory(normalized, historyIdentity, null, { limit: Infinity }));
    note("ui.daily_sweep_all_ms", allMs);
    const keys = series.series.map((s) => s.key);
    const [bucketMs, weekly] = await timed(() => lib.ownershipHistoryBuckets(series.data, keys, "week", "period"));
    note("ui.bucket_ms", bucketMs);
    const [plotMs, plot] = await timed(() => lib.coarsenPlotRows(series.data, keys, lib.plotBudget(1000, "area"), "cumulative"));
    note("ui.plot_ms", plotMs);
    const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
    result = {
      dataset: {
        repo_count: repoIds.length,
        reports: reports.length,
        repo_days: normalized.reduce((n, h) => n + h.days.length, 0),
        legacy_history_repos: histories.filter((h) => h.legacy).length,
        legacy_history_rows: sqlite.prepare("SELECT COUNT(*) AS n FROM line_ownership_history").get().n,
        raw_identities: normalized.reduce((n, h) => n + h.identities.size, 0),
        credits: reports.reduce((n, r) => n + r.report.credits.length, 0),
        people: summary.authors.length,
        matched_github_ids: summary.authors.filter((a) => a.githubId).length,
        unmatched_identities: summary.authors.filter((a) => a.matched === false).length,
        db_bytes: statSync(real).size,
      },
      query: { snapshot_bytes: snapshotBytes, history_bytes: historyBytes },
      ui: { calendar_days: series.data.length, plot_input_points: series.data.length * keys.length, plotted_points: plot.rows.length * keys.length, plot_factor: plot.factor, weekly_rows: weekly.length },
      checksums: {
        summary: digest(summary.authors.map((a) => [a.key, a.lines])),
        selection: digest([selected.totalLines, selected.creditedLines]),
        history: digest(series),
      },
    };
  }
  const timings = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, stats(v)]));
  const report = {
    machine: { platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cores: cpus().length, memory_gb: +(totalmem() / 2 ** 30).toFixed(1), node: process.version },
    runs, ...result, timings,
  };
  console.log(JSON.stringify(report, null, 2));
  console.log("\nmetric                              median     min     max");
  for (const [key, s] of Object.entries(timings)) console.log(`${key.padEnd(34)} ${String(s.median).padStart(8)} ${String(s.min).padStart(7)} ${String(s.max).padStart(7)}`);
  if (flag("save")) writeFileSync(flag("save"), JSON.stringify(report, null, 2) + "\n");
  if (flag("baseline")) {
    const baseline = JSON.parse(readFileSync(flag("baseline"), "utf8"));
    const same = JSON.stringify(baseline.checksums) === JSON.stringify(report.checksums);
    console.log(same ? "\nOutputs match the baseline." : `\nOutputs DIFFER from the baseline:\n  baseline ${JSON.stringify(baseline.checksums)}\n  now      ${JSON.stringify(report.checksums)}`);
    if (!same) process.exitCode = 1;
  }
} finally {
  sqlite.close();
  rmSync(work, { recursive: true, force: true });
}
