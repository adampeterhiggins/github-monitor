# GitHub Monitor

A native macOS app that gives you GitHub's **Insights** analytics across a whole
organisation instead of one repository at a time. Every page GitHub offers per repo
is here, with **repository turned into a filter** you slice by — plus a
**contributor filter**, which GitHub has no equivalent of.

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

## Filters

**Repository.** Curate the set in **Settings → Repositories** (a checkbox list with
per-repo commit counts), or change it quickly from the dropdown on any page. Both
write the same persisted selection. Presets: select all, clear, active in the last
12 months, has any activity, and **"Repositories I've committed in"** — which reads
your own commits out of the local cache, so it is instant and costs no API quota.
It needs a sync to have run first, and says so when it hasn't.

**Contributor.** Narrows pages to specific people. Because the underlying data
varies, each page declares what it can honour rather than pretending:

| Support | Pages | Why |
|---|---|---|
| Full | Contributors, Code frequency, Pulse | Per-contributor data exists |
| Partial | Commits, Forks | See below |
| Not available | Punch card, Traffic, Community, Dependency graph, Network, Actions × 2 | GitHub supplies no per-contributor breakdown |

On **Commits**, everything respects the filter except *Commits by day of week*,
which comes from `stats/commit_activity` — day totals with no contributor
dimension. On **Forks**, a login matches the *fork owner*, which is a different
notion from a contributor. Where the filter cannot apply, the control is visibly
disabled with the reason; a filter that silently changed nothing would be worse
than none.

Note the deliberate asymmetry: **no repositories selected means no data**, whereas
**no contributors selected means everyone**. Repositories are an explicit opt-in
list; the contributor filter is a narrowing applied on top, so its empty state has
to mean unfiltered or every page would start blank.

Code frequency switches source when filtered: unfiltered it uses GitHub's repo-wide
`code_frequency` series, filtered it uses `contributor_weeks`, the only table with
per-person line counts. Filtered totals can therefore sit slightly below unfiltered
ones, since the former only counts work GitHub could attribute to an account. The
page says which source is in use.

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

## Why there are no database transactions

`tauri-plugin-sql` connects with sqlx's `Pool::connect`, whose default is
**`max_connections = 10`**. Every `db.execute()` borrows an arbitrary connection, so
a transaction opened by `execute("BEGIN")` is invisible to the next call if it lands
elsewhere. Issuing `BEGIN`/`COMMIT` as separate calls produced two failures under
concurrent sync:

- `cannot start a transaction within a transaction` — two `BEGIN`s on one connection
- `cannot commit - no transaction is active` — `COMMIT` on a connection that never saw the `BEGIN`

Multi-statement atomicity therefore isn't available. Instead each write is a single
statement (`bulkInsert` batches many rows into one multi-row `INSERT` for exactly
this reason), and delete-then-repopulate pairs run under `withWriteLock` so they
stay adjacent and concurrent writers don't interleave. A failed write is recorded in
`sync_state` and retried. `scripts/test-queries.mjs` asserts no query emits
`BEGIN`/`COMMIT`/`ROLLBACK`, so the class of bug cannot come back unnoticed.

## Testing

```bash
npm run check   # typecheck + query tests
```

`npm run test:queries` runs the real query functions against a real SQLite database
built from the real schema, via Node's built-in `node:sqlite`. No GitHub access and
no Tauri runtime: `queries.ts` only type-imports the SQL plugin, so it can be
bundled and driven with a thin adapter.

This exists because two classes of bug are invisible to `tsc`, and both have already
been caught by it:

- a schema statement severed by a semicolon **inside a comment**, which meant the
  `code_frequency` table silently failed to be created;
- `listContributors` splitting one person across two rows when login casing differed,
  while the filter matched both case-insensitively.

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
