# Line ownership performance implementation plan

This plan turns the options in [performance_improvement.md](performance_improvement.md#comparison-of-the-responses) into an implementation sequence. It covers all 15 rough options in that comparison. The recommendations in the transcripts are hypotheses or partial measurements, not a measured end-to-end speedup for this application. Preserve the current ownership meaning, contributor selection, daily chart values, cancellation, and restart behavior throughout.

## Current path and intended result

- Rust calculates a HEAD snapshot and walks first-parent history in [`src-tauri/src/line_ownership.rs`](src-tauri/src/line_ownership.rs). `advance_history` takes at most 25 commits, rebuilds the remaining commit list and alias set per batch, calls `scan_snapshot_at` for each commit, and serializes its file cache. A global calculation mutex admits one repository at a time.
- [`src/lib/ingest/lineOwnership.ts`](src/lib/ingest/lineOwnership.ts) sends that cache through the WebView, and [`src/lib/db/lineOwnership.ts`](src/lib/db/lineOwnership.ts) saves commit points and the checkpoint. The UI query uses a window function to retain the last commit of each UTC day.
- [`src/pages/LineOwnership.tsx`](src/pages/LineOwnership.tsx) keys its queries on `syncing` and reloads full snapshots, history, and accounts every five seconds during sync. [`src/lib/lineOwnership.ts`](src/lib/lineOwnership.ts) reconstructs identities and daily series; [`src/components/LineOwnershipCharts.tsx`](src/components/LineOwnershipCharts.tsx) passes the plotted series to the shared Recharts component in [`src/components/charts.tsx`](src/components/charts.tsx).
- The target is a responsive filter and chart even during sync, and a history sync whose cost follows actual changed lines and displayed days rather than repeated full-history work. Keep exact underlying values for exports, tooltips, and checks even when the plotted representation is reduced.

## Baseline and correctness contract

Before changing algorithms, add a repeatable benchmark harness using a copy of representative local data and cached Git repositories. Capture at least a small repository, a long-lived repository, and a repository with merges. Record repository count, commits, distinct UTC days, file count, author rows, database bytes, and machine details alongside every run. Do not put personal data or a copied database in the repository.

Measure separately: HEAD scan; history wall time, Git subprocess count, blame time, tree/log/alias time, checkpoint serialization/transfer, and peak memory; SQLite query time and bytes transferred; identity preparation; period projection; and actual desktop chart input-to-paint time for repository, contributor, period, cumulative/per-period, shape, split, and “All” changes. Repeat warm and cold runs. Use the existing [`scripts/test-line-ownership.mjs`](scripts/test-line-ownership.mjs) and Rust history tests as a starting point, but keep benchmarks separate from correctness tests.

A result is correct only if it preserves these observable rules:

1. The HEAD snapshot stays exact at its pinned revision. Each history point uses the same last commit per UTC day as the existing query, with days without commits carrying the previous totals.
2. Surviving-line authorship, `-w` whitespace behavior, renames, restores, merge attribution, co-authors, exclusions, generated/binary files, `.mailmap`, GitHub account aliases, bot filters, and cross-repository identity joining match the existing implementation or an explicitly reviewed correction.
3. Cumulative and per-period readings, grouping, contributor selection, “Other,” shares, legend, brush, tooltip, and export agree with full-resolution data. Co-authors can legitimately make stacked credited lines exceed physical surviving lines.
4. Cancellation, full resync, incremental sync, rewritten default branches, a crash between writes, and restart from a checkpoint never silently mark incomplete history as complete.

For each major change, compare output against the old implementation on fixtures and representative real repositories before retiring the old path. Use a versioned format and a controlled rebuild path where output cannot be migrated exactly. Ship the stages below independently, with timings after each stage, because several proposals attack the same work and their claimed gains are not additive.

## Work sequence

| Stage | Deliverable | Options covered | Main dependency |
| --- | --- | --- | --- |
| 0 | Baseline, parity fixtures, timings | Evidence for all | None |
| 1 | Fast and reusable identity preparation | I, R, T, W | Stage 0 |
| 2 | Incremental loading and refresh | K, E | Stage 0; benefits from stage 1 |
| 3 | Bounded chart rendering | L, A, V | Stage 0 |
| 4 | Persistent Rust history engine and cheaper loop | G, C, P | Stage 0; stabilize before changing attribution |
| 5 | Forward line replay and daily output | F, D | Stage 4 |
| 6 | Compact daily storage and migration | S | Stages 1, 2, and 5 |

Stages 1–3 can be implemented independently. Within stage 4, first remove repeated work and make state durable, then raise concurrency. Stage 5 should replay **every commit diff needed for correctness** while emitting only the daily points needed by the graph. That implements the daily-endpoint proposal without silently skipping intervening edits. The chart renderer alternatives in stage 3 are a measured choice: disable Recharts animation immediately, then select a default dense-data renderer and a fallback as needed; there is no value in maintaining several equivalent renderers indefinitely.

## Stage 1 — Fast and reusable identity preparation

### I. Fix or deduplicate the identity join

**Code:** `prepareOwnershipHistory` in `src/lib/lineOwnership.ts`; review the smaller union-find implementations in `aggregateOwnership` and Rust `aggregate` for the same chain issue.

- Add path compression and union by size/rank to `find`/`union`. Replace `members.set(root, [...old, index])` with an append to the existing array.
- Intern identical normalized author tuples before unioning them. Use a stable tuple of author, normalized names, and lowercased emails; do not use object identity or just a display name as the deduplication key. Map every original row to its interned identity, then accumulate its line totals without losing co-author deduplication.
- Resolve GitHub login/ID aliases using the same rules as current selection and keep person keys stable across repository selections where possible. Check name collisions and one email associated with more than one displayed name.
- Add parity tests for multiple aliases, the same author object repeated over many days, account renames, co-authors credited once per person, unmatched emails, bot selection, and no contributor match.

**Exit:** Byte-equivalent prepared data on representative current data and fixtures; record preparation time and allocations. This is the first UI performance change because several transcripts measured seconds in this function.

### R. Reuse resolved identities across filter changes

**Code:** split `prepareOwnershipHistory` into identity resolution, per-repository history normalization, and selected-contributor projection; update `OwnershipHistoryChart` memoization and query keys.

- Build an immutable identity index for the current account-map version and loaded repository history. Changing selected contributors, split, period, or shape should not rebuild the alias graph.
- Keep raw per-repository/day author totals and resolve selections against canonical person keys after identity resolution. A repository addition should extend the index or rebuild only the affected component when aliases connect it to existing people; a removal must not leave a false alias bridge. If incremental union deletion proves unsafe, rebuild the *small interned identity graph* while retaining normalized rows.
- Invalidate the index when GitHub account mappings, repository history revisions, or identity rules change. Do not use a cache key based only on array reference or `syncing`.

**Exit:** Repeated contributor and chart-control changes perform no full author-row union pass; parity holds when selecting and deselecting repositories in different orders.

### T. Build the daily chart series with an event sweep

**Code:** replace the nested repository × day × author carry loop in `prepareOwnershipHistory`; keep `projectOwnershipHistory` and `ownershipHistoryBuckets` semantics.

- Convert each repository's sorted daily snapshots into deltas from its preceding snapshot. At each UTC day, apply all repository deltas to running totals by canonical person and repository, then emit that day's aggregate. Carry the running totals through empty days without iterating every repository's author list again.
- For the first point of a repository, treat its whole snapshot as an insertion. For deleted authors, emit negative deltas. Preserve the existing treatment of duplicate commits on one day and of the earliest/latest day of the selected repositories.
- Materialize only what the current view needs; retain exact daily levels for period calculations and export. Check that cumulative levels and period differences remain identical to the old implementation.

**Exit:** Prepared history cost grows with input changes plus output days/series rather than days × repositories × authors; old and new series compare exactly.

### W. Move any remaining heavy preparation off the UI thread

**Code:** a dedicated Web Worker for normalized history/identity projection, called from `OwnershipHistoryChart` after stages I/R/T.

- Send compact, transferable data with a revision/request ID. Ignore obsolete responses after a rapid filter change, cancel or supersede old work, and keep controls interactive while a result is pending.
- Keep the React component responsible for view state and rendering, not for a multi-second synchronous `useMemo`. Avoid repeatedly cloning large author JSON into the worker: if transfer overhead approaches computation time, move the computation closer to the database instead.
- Provide a simple synchronous fallback for small datasets and tests. Measure both worker compute and transfer time; retain the worker only if it improves actual input-to-paint latency.

**Exit:** No long main-thread task on filter changes for the benchmark data; worker output matches the synchronous implementation.

## Stage 2 — Incremental loading and refresh

### K. Cache or load history per repository

**Code:** `ownershipHistory`/`ownershipSnapshots` in `src/lib/db/lineOwnership.ts` and their React Query usage in `src/pages/LineOwnership.tsx`.

- Fetch each repository's daily points under a key containing `repo_id` and a durable history revision/generation. Compose the selected repositories in memory; selecting one more repository should fetch only that repository. Cache parsed points and bound the cache by size or least-recently-used eviction so an entire organization does not remain in WebView memory indefinitely.
- Return only the report portion needed by the page instead of extracting a large HEAD snapshot JSON each time. Keep repository status, revision, and errors in a lightweight query.
- After compact storage arrives, use indexed `(repo_id, UTC_day)` reads and avoid the current per-commit window-function query. Until then, verify a covering index and query plan for the current daily query.

**Exit:** Adding/removing a cached repository causes no reload or parse of other repositories. Cold loading remains correct; cache memory has a measured bound.

### E. Refresh only changed data during sync

**Code:** sync completion path in `src/lib/ingest/sync.ts`, query invalidation in `src/pages/LineOwnership.tsx`, and a small revision/status probe in the database.

- Remove `syncing` from full-data query keys and stop five-second full history/snapshot/account reloads. After each durable repository history update, publish `{repoId, historyRevision, snapshotRevision, accountsRevision}` and invalidate only affected queries. The current `markDone` path is a natural place for a repository-complete event, while batch progress can signal newly durable daily points if live partial history is required.
- Use a cheap revision/status poll only as a recovery path for missed events, external writes, or app resume. Account mapping changes invalidate the identity index across selected repositories; ordinary repository progress should not.
- On cancellation or error, preserve the last successful chart and show status separately. On a full rebuild, invalidate the old generation when the new data is durable rather than displaying a partially deleted series.

**Exit:** Syncing many repositories no longer repeatedly transfers all selected history. A finished repository appears promptly, and recovery polling catches missed events.

## Stage 3 — Bounded chart rendering

### L. Plot at display resolution

**Code:** `OwnershipHistoryChart` and the history-specific plot path, leaving the shared `TimelineArea` behavior for other pages alone unless a general change is proven safe.

- Derive a point budget from the chart's rendered width, current brush window, shape, and number of visible series. Keep first/last points, extrema, sign changes, and sharp per-period changes. Downsample *after* exact UTC-day/period and share calculations; simple every-Nth sampling can hide peaks or invent changes.
- Keep the complete series for export and accurate lookup. Map pointer position/brush bounds back to full-resolution timestamps; the tooltip should report the exact point or an explicit aggregate for the displayed bucket.
- Bound “All” by visible work rather than silently changing the requested data. For very many series, use a dense renderer or show a documented series limit/virtualized legend. Verify stacked totals and negative per-period values.

**Exit:** Daily and “All” views draw work proportional to viewport size, while extrema and full-resolution numeric output remain correct.

### A. Disable expensive animation

**Code:** pass a history-specific `isAnimationActive={false}` or equivalent through `TimelineArea` to its Recharts `Area`, `Line`, and `Bar` series and brush where relevant.

- Limit this to ownership history first. Keep animation choices for unrelated charts unchanged.
- Measure period/cumulative/shape switch latency before and after. Animation removal should be evaluated separately from data preparation and point reduction.

**Exit:** Settings changes do not wait for a long chart morph; no regression in brush, tooltip, or legend.

### V. Select a dense-data renderer

**Code:** a history-specific plot component. Candidates from the transcripts are one SVG path per series, Canvas, or a suitable charting library.

- Prototype one SVG path per series with the existing palette, stacked/overlaid area, lines, bars, axes, brush, pointer lookup, legend, accessible labels, and resize behavior. Compare input-to-paint, memory, and fidelity against bounded Recharts on the same data.
- If “All” still produces too many paths or dense bars, use Canvas for the marks while retaining accessible DOM controls and an exact data lookup for interaction. Avoid adding another chart dependency until a measured gap justifies it.
- Preserve current shape and reading semantics. A custom renderer must explicitly handle shares, negative period changes, co-author totals above physical lines, dark/light theme, and high-DPI rendering.

**Exit:** Select one maintained history rendering path based on measured performance and feature parity. Document any deliberate limit on the “All” view.

## Stage 4 — Persistent, cheaper sync engine

### G. Remove repeated Git and tree work

**Code:** `advance_history`, `first_parent_commits`, `history_aliases`, and `scan_snapshot_at` in `src-tauri/src/line_ownership.rs`.

- Build the first-parent commit schedule and alias index once for the pinned target, not once per 25-commit batch. On resume, continue from an indexed cursor; on a rewritten branch, discard the incompatible schedule and rebuild.
- Resolve repo path, bare/shallow status, options, pathspec/exclusion patterns, and relevant Git capabilities once per job. Batch commit metadata and co-author bodies. Maintain tree/path metadata through commit diffs where safe rather than issuing a full `ls-tree` for each step; retain a full-tree fallback for uncertain cases and verify it against reference scans.
- Count subprocesses by command type and record their wall time. Keep cancellation checks in long-running Git processes and bound buffers for large repositories.

**Exit:** No work proportional to *remaining history* repeats at each batch; fixed subprocess work per commit is substantially reduced with identical history results.

### C. Own checkpoints and HEAD cache natively

**Code:** Rust history command, `src/lib/ingest/lineOwnership.ts`, `src/lib/db/lineOwnership.ts`, and schema.

- Replace the JavaScript loop that reads `line_ownership_history_state.cache`, sends it to Rust, receives a full JSON checkpoint, and writes it again. A Rust job should retain working state in memory while running and persist a versioned checkpoint at a bounded interval. Return progress and compact results, not the whole file cache.
- Use a crash-safe handoff: write a checkpoint to a versioned temporary file, flush and atomically rename it, then atomically commit history points plus the matching checkpoint pointer/cursor in SQLite. Keep the previous checkpoint until that commit succeeds; orphan files can be collected later. The current SQL plugin uses pooled connections and cannot make a JavaScript sequence of `BEGIN`/`COMMIT` calls atomic, so this path needs a single Rust-owned SQLite transaction or an equivalent single-connection writer. Coordinate with the existing WAL database and its write contention policy.
- Separate the HEAD report used by the page from its large per-file cache. Store the cache behind a native reference and keep the report/revision visible atomically. Version checkpoint and report formats; migrate or rebuild old caches without losing the last successful visible report.
- Keep full resync, cancellation, app crash, and resumed sync idempotent. Commit history before moving its cursor, and never let a checkpoint pointer refer to missing or partially written state.

**Exit:** Checkpoint bytes do not cross the WebView per batch; a kill/restart at every persistence boundary resumes to the same final result as an uninterrupted run.

### P. Calculate repositories concurrently within resource limits

**Code:** replace the single `ScanControl.calculation` mutex; coordinate with the two-repository pool in `src/lib/ingest/sync.ts` and the current per-scan `worker_count()`.

- Start with a small repository semaphore (for example 2–4 slots), plus a global cap on active Git/blame subprocesses and memory. Permit HEAD and history jobs to share resources without allowing one large repository to starve others.
- If forward replay leaves occasional expensive blame fallbacks, queue `(repository, path, revision)` blame jobs globally so workers remain busy even when a commit changes only one file. Preserve deterministic aggregation irrespective of completion order.
- Measure throughput and peak memory at each concurrency level. Respect cancellation, per-repository error isolation, and SQLite write contention; choose defaults from the measured laptop workload rather than core count alone.

**Exit:** Several repositories make progress concurrently and total organization sync time improves without UI stalls or an uncontrolled process/memory spike.

## Stage 5 — Forward replay and daily history

### F. Replay line origins through diffs

**Code:** a new Rust history replay module called by `advance_history`; keep `scan_snapshot_at` as a reference and fallback.

- At a full scan or compatible checkpoint, store each text file's surviving line origins as compact indexes into a deduplicated commit/identity table. For each subsequent first-parent commit, apply a whitespace-aware diff: unchanged lines keep origins, removed lines disappear, and genuinely new lines receive the appropriate commit's author/co-author attribution. Update path/blob metadata for adds, deletes, renames, copies, restores, mode changes, and binary transitions.
- Treat merges explicitly: a first-parent diff can falsely credit lines brought from a merged branch to the merge commit. Re-blame affected paths or derive their true origin through a verified merge-aware path. Also fall back to blame for legacy checkpoints, unsupported diff cases, and any mismatch with reference output. `.mailmap` changes and option changes must trigger the required rebuild or remapping.
- Recompute compact per-person totals from changed files/deltas rather than re-aggregating the whole tree for each commit. Retain exact HEAD scanning independent of the history optimization.
- Differentially compare every replayed commit against `scan_snapshot_at` on generated Git fixtures covering whitespace, edit/delete/insert, rename/copy, restore, merges, co-authors, binary files, exclusions, and checkpoints from the old version. Run representative real-repository comparisons before making replay the default.

**Exit:** Attribution matches full blame at each checked revision; history wall time and Git-blame count fall materially. Keep the fallback path until parity and restart behavior are established.

### D. Emit daily endpoints, with an exact HEAD state

**Code:** first-parent schedule/replay and history persistence/query.

- Partition commits by the same UTC day rule used by the current SQLite query, preserving its last-commit ordering and tie break. Process all intervening diffs so a change-and-revert or merge remains correct, but aggregate and persist one end-of-day point per repository/day. Continue to the exact pinned HEAD state for incremental sync even if it is not the last persisted day point yet.
- For the old blame-based engine, a daily-snapshot interim path may scan selected endpoints only if it tracks *all paths touched between endpoints*; a tree diff of the endpoints alone is insufficient. Once forward replay is in place, prefer replaying all commits and emitting only daily results.
- Verify the new point series against the old window-function output on repositories with multiple commits per day, equal timestamps, empty days, day-boundary time zones, force pushes, and partial syncs. Clarify whether a currently running day is visible after each durable batch.

**Exit:** The chart's daily values match the old query and persistence volume tracks repository-days, while the HEAD checkpoint remains exact.

## Stage 6 — Compact daily storage

### S. Normalize identities and history rows

**Code:** add versioned tables/indexes in [`src/lib/db/schema.ts`](src/lib/db/schema.ts), a backfill/migration path, and replace `ownershipHistory` reads.

- Store one `(repo_id, UTC_day, revision, committed_at)` point and compact `(repo_id, UTC_day, identity_id, lines)` rows or deltas. Put normalized raw names/emails and GitHub account mappings in separate tables. Index `(repo_id, UTC_day)` and identity lookups. Keep total and co-authored line counts where the chart/summary needs them.
- Distinguish a **raw identity** from the current canonical person. Cross-repository alias links and new GitHub account matches can change who merges with whom; do not permanently bake a person ID at sync time without an invalidation/remap strategy. Version the identity graph and remap small identity IDs when account data changes. Preserve current co-author credit and `NO_CONTRIBUTORS` behavior.
- Backfill existing `authors_json` per repository without blocking normal reads. Dual-read or dual-write during migration, compare old and new daily series, then switch queries. Keep old data until parity succeeds; make a full history rebuild available if a checkpoint version is incompatible. Bump the schema version and make repeated startup idempotent.
- Combine compact rows with the per-repository cache and event-driven invalidation from stage 2. Query only selected repositories and required days; avoid transferring repeated names/emails or a per-commit window query to the WebView.

**Exit:** Identical chart and selector output on migrated and freshly synced data; database size, query time, IPC bytes, and chart preparation time are recorded before/after. Recovery works after a crash mid-backfill.

## Release gates and final validation

1. Run TypeScript and existing line ownership/query tests after each stage. Add focused fixture tests for changed semantics, not tests that merely mirror the implementation. Run Rust history tests for stages 4–5 and the app's normal checks before integration.
2. Run parity on a saved database copy and a varied set of Git clones. Compare per-repository/day author totals, aliases, co-author totals, HEAD reports, selected-contributor series, and export values. Investigate any difference before changing the default path.
3. Profile the packaged desktop app, not just Node. Record median and high-percentile input-to-paint latency for all chart controls while idle and during an organization sync; record full and incremental sync wall time, Git commands, peak memory, checkpoint/IPC bytes, and database size. Use the same representative data for every comparison.
4. Roll out the history format with a version check and a recoverable rebuild path. Keep old data/checkpoints until the new results pass parity. Include a way to diagnose which engine and schema generation produced a repository's history.
5. Accept each optimization only when it preserves the correctness contract and reduces a measured bottleneck. If a worker, Canvas renderer, or second chart implementation does not improve the packaged app after earlier stages, document the result and omit that extra runtime path; the option has still been evaluated.
