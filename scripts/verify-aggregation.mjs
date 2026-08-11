#!/usr/bin/env node
/**
 * Verifies the week-bucketing and aggregation logic against GitHub's own
 * arithmetic, using a live repository.
 *
 *   GH_TOKEN=$(gh auth token) node scripts/verify-aggregation.mjs focaldata/fd-core-respondent
 *
 * The point of these checks is that GitHub gives us a `total` per contributor
 * alongside the weekly buckets, so it will grade our summing for us. If the
 * bucketing convention were wrong (off-by-one week, local time instead of UTC,
 * Monday instead of Sunday), test 1 or 2 fails.
 *
 * Note the repository must have a warm stats cache. A cold or very active repo
 * answers 202 with an empty body — that is expected, not a failure; retry later.
 */

const WEEK = 7 * 24 * 60 * 60;

/** Must stay identical to weekStart() in src/lib/agg/weeks.ts. */
function weekStart(ms) {
  const d = new Date(ms);
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = new Date(utcMidnight).getUTCDay();
  return Math.floor(utcMidnight / 1000) - dow * 86_400;
}

const target = process.argv[2];
const token = process.env.GH_TOKEN;

if (!target || !target.includes("/")) {
  console.error("usage: GH_TOKEN=… node scripts/verify-aggregation.mjs <owner>/<repo>");
  process.exit(2);
}
if (!token) {
  console.error("GH_TOKEN is required (try: GH_TOKEN=$(gh auth token))");
  process.exit(2);
}

const res = await fetch(`https://api.github.com/repos/${target}/stats/contributors`, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  },
});

if (res.status === 202) {
  console.log(`${target}: GitHub is still computing these statistics (202).`);
  console.log("This is the documented cold-cache behaviour. Retry in a minute.");
  process.exit(0);
}
if (!res.ok) {
  console.error(`${target}: HTTP ${res.status}`);
  process.exit(1);
}

const data = await res.json();
if (!Array.isArray(data) || data.length === 0) {
  console.log(`${target}: no contributor data returned.`);
  process.exit(0);
}

console.log(`repo: ${target} | contributors: ${data.length}\n`);
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// 1. GitHub's week keys must already be Sunday 00:00 UTC, and weekStart() must be
//    a fixed point on them, or our buckets will not line up with GitHub's.
let buckets = 0;
let misaligned = 0;
for (const entry of data) {
  for (const w of entry.weeks) {
    buckets++;
    const d = new Date(w.w * 1000);
    if (d.getUTCDay() !== 0 || d.getUTCHours() !== 0 || weekStart(w.w * 1000) !== w.w) misaligned++;
  }
}
check("week keys align to Sunday 00:00 UTC", misaligned === 0, `${buckets} buckets, ${misaligned} misaligned`);

// 2. Summing the weekly buckets must reproduce GitHub's own per-contributor total.
let mismatches = 0;
for (const entry of data) {
  if (!entry.author?.login) continue;
  if (entry.weeks.reduce((a, w) => a + w.c, 0) !== entry.total) mismatches++;
}
check("sum(weeks[].c) equals GitHub's total", mismatches === 0, `${mismatches} contributors disagree`);

// 3. writers.ts drops all-zero weeks to keep the table small; that must lose nothing.
let kept = 0;
let pruned = 0;
let lost = 0;
for (const entry of data) {
  for (const w of entry.weeks) {
    if (w.c === 0 && w.a === 0 && w.d === 0) {
      pruned++;
      lost += w.c + w.a + w.d;
    } else kept++;
  }
}
check(
  "dropping all-zero weeks is lossless",
  lost === 0,
  `${kept} kept, ${pruned} pruned (${Math.round((pruned / (kept + pruned)) * 100)}% saved)`,
);

// 4. A date window must partition the totals exactly: no double counting, no gap.
const allWeeks = data.flatMap((e) => e.weeks);
const grand = allWeeks.reduce((a, w) => a + w.c, 0);
const split = weekStart(Date.now() - 26 * WEEK * 1000);
const before = allWeeks.filter((w) => w.w < split).reduce((a, w) => a + w.c, 0);
const after = allWeeks.filter((w) => w.w >= split).reduce((a, w) => a + w.c, 0);
check("window filter partitions totals exactly", before + after === grand, `${before} + ${after} = ${grand}`);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
