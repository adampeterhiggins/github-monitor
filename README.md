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
| Pulse | GraphQL PRs + issues | Derived — GitHub has no Pulse API. Adds size vs time-to-merge and open-PR age. |
| Contributors | `stats/contributors` | Exact parity, plus stacked breakdowns |
| Community | `community/profile` | Health score + checklist coverage matrix |
| Traffic | `traffic/*` | 14-day GitHub limit; accumulates locally, including referrer share |
| Commits | `stats/commit_activity`, `stats/contributors` | Day-level detail covers 52 weeks |
| Code frequency | `stats/code_frequency` | Additions/deletions around a zero baseline |
| Punch card | `stats/punch_card` | **All-time only** — no date dimension exists |
| Dependency graph | `dependency-graph/sbom` + Dependabot alerts | Sharing, version drift, and open alerts joined to drift |
| Network | `branches`, `forks` | Branch/fork topology, not a commit graph |
| Forks | `forks` | |
| Actions usage | `actions/runs` | Wall-clock elapsed, not billable minutes |
| Actions performance | `actions/runs` | p50/p90/p99 duration, failure rates |
| Ownership | `contributor_weeks` | Bus factor, concentration over time, people × repositories matrix — no GitHub equivalent |
| People | `contributor_weeks` + PRs | One person across the org, not across all of GitHub |
| Roster | `contributor_weeks` | Arrivals, last-seen, and repositories left cold |
| Scorecard | several | One ranked table joining concentration, health, alerts, open PRs, lead time, views |

## Releasing and updating

Modelled on t3code's release flow — preflight resolves the version, build produces
artifacts, release publishes them, a final job updates the update manifest — but
implemented for Tauri rather than Electron, and **stable channel only**.

### One-time setup

The signing key is what the app uses to prove an update is genuinely yours; without
it, an update cannot be installed.

```bash
# 1. Generate a keypair (already done if .updater/ exists — it is gitignored)
npx tauri signer generate -w .updater/signing.key -p ""

# 2. Give CI the private key
gh secret set TAURI_SIGNING_PRIVATE_KEY < .updater/signing.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body ""
```

The **public** key lives in `src-tauri/tauri.conf.json` and is committed — that is
what each build trusts. **Back up `.updater/signing.key`.** Lose it and existing
installs can never be updated again; they would need replacing by hand.

### Cutting a release

```bash
make release          # gate, bump if needed, check, commit, tag, push, watch CI, verify
make release-0.3.0    # release exactly 0.3.0
make release YES=1    # no prompts
make release PUSH=0   # rehearse: stops after tagging, pushes nothing
```

`make` on its own lists everything. `make doctor` checks the prerequisites (tooling,
the universal-build target, the signing key, the repo secret, git state) before you
find out the hard way.

The chain is: version gate → bump → `npm run check` → commit → tag → push → follow
the CI run → **verify the published manifest is actually installable**. That last
step reads the same URL with the same auth the app uses, so a green CI run with a
broken manifest still fails.

| Knob | Effect |
|---|---|
| `FORCE=1` | skip the version gate (rebuild the same version) |
| `YES=1` | accept prompts; required in a non-interactive shell |
| `PUSH=0` | stop after tagging |
| `WATCH=0` | don't follow the CI run |

Other useful targets: `make version` (reports drift across the three files),
`make set-version-0.3.0`, `make app` (build and install into `/Applications`,
verifying the installed version), `make runs`, `make watch`,
`make verify-release`, and `make release-local` if CI is broken and you need to
publish from your laptop.

The equivalent long-hand, if you prefer:

```bash
npm run release:prepare -- 0.2.0    # bumps package.json, tauri.conf.json, Cargo.toml
git commit -am "chore(release): 0.2.0"
git tag v0.2.0
git push origin main --tags
```

The workflow then builds a signed **universal** macOS bundle, publishes a GitHub
Release with the `.dmg`, `.app.tar.gz` and `.app.tar.gz.sig`, and commits a
`latest.json` to the `releases` branch. The running app picks it up on its next
check — 15 seconds after launch, then every 6 hours — or immediately via
**Settings → Updates → Check now**.

`workflow_dispatch` with a version input does the same thing without a local tag.

Preflight **fails deliberately** if `tauri.conf.json`'s version disagrees with the
tag. That mismatch is silent but nasty: the updater compares against the config
version, so the app would either re-offer a version it already runs or never offer
it at all.

### How updates reach a private repo

This repository is private, so the updater cannot fetch anonymously. Two facts make
it work without any Rust:

- the plugin sends configured request headers on **both** the manifest fetch and
  the binary download, defaulting `Accept` only when unset — `application/json` for
  the manifest, `application/octet-stream` for the download. Passing just
  `Authorization` therefore leaves both correct;
- `raw.githubusercontent.com` honours a bearer token on private repositories, and
  so does `api.github.com/repos/…/releases/assets/<id>`.

So the manifest lives on the `releases` branch (a stable URL, unlike per-release
asset ids) and points the download at the asset's **API** URL. Both were verified
against this repository before the code was written: authenticated requests return
200, unauthenticated ones 404.

The app reuses the GitHub token you already gave it, so updating needs no extra
credential — but it does mean **only accounts with read access to this repository
can update**. If that becomes limiting, host the artifacts in a small public repo
and drop the auth headers.

**`raw.githubusercontent.com` caches**, so a freshly published manifest is not
served immediately. Measured on the v0.1.1 release: **182 seconds** between the
commit landing on the `releases` branch and raw serving it. Harmless for updates,
which are not urgent, but it means:

- the app will not offer a new release for roughly three minutes after the run
  goes green;
- **verification must not gate on raw**, or every release would look broken. Both
  the workflow and `make verify-release` check the `releases` branch through the
  contents API, which is authoritative about what was committed, and report raw's
  state for information only.

### Why no nightly channel

t3code ships stable and nightly. Tauri's JS updater API cannot switch endpoints at
runtime and there is no `{{channel}}` template variable, so a user-selectable
channel needs a custom Rust command wrapping `updater_builder().endpoints(…)`.
Stable-only keeps the whole implementation in TypeScript. Adding nightly later
means: a scheduled trigger, a second `nightly.json`, and that Rust command.

### Saved selections

Groups of repositories or contributors can be named and reused. Save from either
filter dropdown ("Save current selection…") or from **Settings → Saved
selections**, which is also where you rename them, overwrite one with whatever is
currently selected, apply, or delete.

They live in SQLite rather than the settings store, for two reasons: a repository
selection is a list of ids that only mean anything alongside the `repos` table, and
`clearAnalytics` deliberately skips the table so wiping the cache never destroys
something you authored. There is a test asserting exactly that.

Repository selections store ids, so one referencing a repository that has since
been deleted shows a **stale** count in Settings and those entries are skipped when
applied — rather than the selection quietly shrinking each time. Contributor
selections store logins and are unaffected.

## Timeline views

Modelled on fd-manager's fieldwork timeline. The Contributors chart — and every
contributor card, which follows the same controls — offers:

| Control | Options |
|---|---|
| Shape | Bars · Area · Line |
| Accumulation | Per period · Cumulative |
| Period | Weekly · Monthly · Quarterly |
| Break down | None · By contributor · By repository |
| Stacking | Stacked · Overlaid (when broken down) |

The legend is clickable: the first click isolates a series, further clicks add or
remove, and clearing the last one returns to showing everything. Hovering gives a
crosshair readout of every visible series at that point, totalled.

Two deliberate details. Fill opacity differs by mode — stacked bands do not
overlap so the fill *is* the encoding and reads solid, whereas overlaid series do
overlap, so there the 2px stroke carries identity and the fill is only a wash that
would otherwise hide what sits behind it. And a cumulative card drops the shared y
scale, because accumulated totals differ by an order of magnitude between the top
and bottom of the list and a shared ceiling would flatten everyone but the leader.

Roll-up and accumulation are applied last, so they compose with every breakdown
rather than each view needing its own path. Both are pure functions in
`lib/agg/series.ts` and tested directly: the failure modes — a cumulative series
that dips, a roll-up that loses a bucket or misplaces a month boundary — all still
draw a plausible curve.

## Breakdowns

The org-wide chart on Contributors can be split **by contributor** or **by
repository** via *Break down*, and **all** contributor cards can be split **by
repository** at once via the *Total / By repository* control above the grid. Both
are stacked columns over the same weekly buckets, and both follow the range
slider, so zooming rescopes the split too.

The card split is one control rather than one per card, and it is served by a
single query grouped by (contributor, repository, week) — per-card fetching would
mean a couple of dozen round trips to answer one question.

The palette has eight categorical slots, assigned in fixed order and never
cycled — a ninth colour would either repeat one already in use or be invented, and
both make the chart lie about identity. So the eight largest contributors or
repositories take the slots and the rest fold into a single muted **Other** band,
which is honest about being an aggregate rather than posing as a category. The
fold is total-preserving: `buildStacks` is tested to conserve the sum, to emit a
row for weeks with no data so the axis has no holes, and to break ties
deterministically so colours do not flicker between renders.

Stacking is also the case the palette was validated for: neighbouring segments are
the pairs that touch, and the adjacent-pair CVD and normal-vision gates both pass.

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
| Full | Contributors, Code frequency, Pulse, Ownership, People, Roster | Per-contributor data exists |
| Partial | Commits, Forks | See below |
| Not available | Punch card, Traffic, Community, Dependency graph, Network, Actions × 2, Scorecard | GitHub supplies no per-contributor breakdown |

On **Commits**, everything respects the filter except *Commits by day of week*,
which comes from `stats/commit_activity` — day totals with no contributor
dimension. On **Forks**, a login matches the *fork owner*, which is a different
notion from a contributor. On **Scorecard**, the filter is off because the row
joins traffic, community health and alerts, which have no person dimension. Where the filter cannot apply, the control is visibly
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

### Resuming an interrupted sync

Every (repository, endpoint) pair's outcome is written to `sync_state` as it
completes — including when a run is cancelled — so an interrupted sync leaves an
accurate record of how far it got. **Settings → Sync** then offers:

- **Resume (N)** — fetches only the outstanding items and leaves finished work
  alone. Shown only when there is both finished and unfinished work, with a
  breakdown of what the N is made of.
- **Full re-sync** — ignores the record and re-fetches everything, which is what
  you want when the data itself has gone stale rather than incomplete.

What counts as finished:

| Status | Resume | Why |
|---|---|---|
| `ok` | skip | got the data |
| `empty` | skip | a repository with no commits still has none |
| `forbidden` | skip | no access will not change without a new token |
| `pending` | **retry** | GitHub was still computing; retrying usually succeeds |
| `error` | **retry** | transient failures are the common case |
| *(no record)* | **attempt** | new repository, or a run that stopped early |

Because `forbidden` is treated as finished, **run a full re-sync after changing
the token** — a resume would keep skipping repositories the old token could not
read.

The decision is a single exported function, `shouldSkip(status, mode)`, tested
directly. Skipping something that had not actually finished is the one way this
feature could quietly lose data, so it is worth isolating. The per-endpoint poll budget is 7 minutes because a
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
  pages/                 one per Insights page, plus Ownership, People, Roster, Scorecard
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
