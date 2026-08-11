# GitHub Monitor

A native macOS app that gives you GitHub's **Insights** analytics across a whole
organisation instead of one repository at a time. Every page GitHub offers per repo
is here, with **repository turned into a filter** you slice by.

Tauri v2 shell (real `.app`, WKWebView, ~10 MB) with all logic in TypeScript.

## Setup

```bash
npm install
npm run tauri dev      # develop
npm run tauri build    # produce .app + .dmg in src-tauri/target/release/bundle
```

On first launch the app asks for a GitHub token. If you have the `gh` CLI
authenticated, **Import from gh CLI** lifts the token straight out of it; otherwise
paste a PAT. It is stored via `tauri-plugin-store` in the app's data directory.

### Token scopes

| Scope | Needed for |
|---|---|
| `repo` | private repository statistics |
| `read:org` | listing organisation repositories |
| push access per repo | **Traffic** only — GitHub's own requirement |
| `security_events` | Dependabot alerts (optional) |

A token without push access still works; Traffic simply stays empty for those repos
and the app says so rather than rendering blank charts.

## Pages

| Page | Source | Notes |
|---|---|---|
| Pulse | GraphQL PRs + issues | Derived — GitHub has no Pulse API |
| Contributors | `stats/contributors` | Exact parity with the website |
| Community | `community/profile` | Health score + checklist coverage |
| Traffic | `traffic/*` | 14-day GitHub limit; accumulates locally |
| Commits | `stats/commit_activity`, `stats/contributors` | Day-level detail covers 52 weeks |
| Code frequency | `stats/code_frequency` | Additions/deletions around a zero baseline |
| Punch card | `stats/punch_card` | **All-time only** — no date dimension exists |
| Dependency graph | `dependency-graph/sbom` | Adds cross-repo sharing + version drift |
| Network | `branches`, `forks` | Branch/fork topology, not a commit graph |
| Forks | `forks` | |
| Actions usage | `actions/runs` | Wall-clock elapsed, not billable minutes |
| Actions performance | `actions/runs` | p50/p90/p99 duration, failure rates |

## How it works, and what to know about the numbers

**The `stats/*` endpoints are lazily computed.** A cold repository answers
`202 Accepted` with an empty body while GitHub builds the statistics in the
background, then returns `200` with data on a later request. Verified against
`focaldata`: of eight repositories probed cold, seven returned 202 and filled in on
retry. A single request is therefore never enough.

The sync exploits this rather than fighting it:

1. **Warm pass** — one request per repository/endpoint, without waiting. GitHub
   starts ~80 background jobs concurrently.
2. **Collect pass** — poll only what was still computing, with backoff inside a
   120-second-per-endpoint budget.

Polling each repository to completion in turn would serialise all that waiting.
Anything still pending is recorded in `sync_state` and picked up next sync, so a
first sync is never wasted. The per-endpoint poll budget is 7 minutes because a
very active repository (`focaldata/orchestra`) was observed returning 202
continuously for over 20 minutes — constant bot pushes appear to keep invalidating
GitHub's cache. Such repositories land in `pending` and are retried; **Settings →
Incomplete data** lists them.

### Why there is no commit-history fallback

An obvious workaround for a perpetually-202 repository is to aggregate commits
directly from GraphQL history instead. That was tried and **deliberately rejected**:
aggregating `orchestra`'s default branch over the same window produced materially
different figures from the website — `claude` (282 commits) and `cursoragent` (179)
did not appear in the branch history at all, and `adampeterhiggins` came out at 134
against the website's 247. Whatever attribution `stats/contributors` applies, a
commit walk does not reproduce it.

Since the whole point is parity with GitHub, a fallback that silently disagrees is
worse than an honest "still computing". The `stats/*` endpoints stay the single
source of truth for commit analytics.

Everything lands in SQLite (`github-monitor.db`) because ~80 repositories is far
too many round trips to make per page view, and because **traffic data expires from
GitHub after 14 days** — the local table is the only way to build longer history.

### Caveats worth knowing

- Commit/contributor figures cover the **default branch and exclude merge
  commits** — GitHub's definition, inherited by using its endpoints.
- `stats/contributors` caps at **100 contributors per repository**.
- Contributors are shown by **raw login**: no bot classification, no alias merging.
  `claude`, `claude[bot]` and `cursoragent` therefore appear as separate
  contributors alongside humans, exactly as GitHub reports them.
- **Pulse definitions are ours**, not GitHub's: "merged" counts PRs whose merge fell
  inside the period regardless of when they opened.
- Actions durations are **wall-clock**, not billable minutes (GitHub rounds up per
  job and multiplies by runner type). The sync caps at 3 pages of runs per repo, so
  very busy repositories may be undercounted — the page says so.
- Punch card has **no date dimension** in GitHub's API, so that page ignores the
  period filter and says so.

## Verifying the numbers

```bash
GH_TOKEN=$(gh auth token) npm run verify:aggregation -- focaldata/fd-core-respondent
```

GitHub returns a `total` per contributor alongside the weekly buckets, so it will
grade our arithmetic for us. The script checks four things, and a wrong bucketing
convention (off-by-one week, local time instead of UTC, Monday instead of Sunday)
fails the first two:

| Check | Result on `fd-core-respondent` |
|---|---|
| Week keys align to Sunday 00:00 UTC | 1,216 buckets, 0 misaligned |
| `sum(weeks[].c)` equals GitHub's `total` | 16/16 contributors agree |
| Dropping all-zero weeks is lossless | 227 kept, 989 pruned — 81% saved, 0 lost |
| A date window partitions totals exactly | 407 + 303 = 710 |

Exact card-for-card comparison against the website was attempted on
`focaldata/orchestra` but could not be completed: that repository returned 202
continuously for over 20 minutes, so GitHub never served the numbers to compare
against. The checks above verify the aggregation itself; parity of the underlying
figures follows from using the same endpoint the website does.

## Architecture

```
src/
  lib/
    github/client.ts     202 polling, rate + secondary limits, ETags, pagination
    github/endpoints.ts  typed endpoint wrappers
    db/schema.ts         SQLite DDL
    db/queries.ts        aggregation in SQL, always scoped by repo id list
    ingest/sync.ts       warm -> collect -> extras -> pulse orchestrator
    ingest/pulse.ts      GraphQL PR/issue ingestion
    agg/weeks.ts         week bucketing (Sunday 00:00 UTC, matching GitHub)
    viz/palette.ts       validated series palette, light + dark
  components/
    charts.tsx           chart primitives with fixed mark specs
    ui.tsx               surfaces, tables, stat tiles, chart/table toggle
    RepoFilter.tsx       the multi-select that makes this org-wide
  pages/                 one per Insights page
```

Aggregation happens in SQL, not JavaScript — summing ~300k weekly rows in the
renderer per page view would be needlessly slow. Weekly rows where every measure is
zero are dropped on write, since GitHub pads its series with empty weeks.

### Charts

Series colors come from a palette validated with a CVD/contrast checker rather than
picked by eye: adjacent-pair worst CVD ΔE 9.1 light / 8.4 dark, normal-vision ΔE
19.6 / 19.3, both modes passing. Three light-mode slots sit below 3:1 contrast, which
obligates a relief channel — so **every chart ships a table view** via the
Chart/Table toggle, and no value is reachable only by telling two fills apart. Dark
mode is a separately selected palette, not a lightness flip.
