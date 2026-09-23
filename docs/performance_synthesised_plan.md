# Line ownership performance and contributor identity plan

This plan combines the measured, concrete changes in `performance_plan.md` with the correctness, migration, and rollout gates in `performance_improvement_plan.md`. It covers I, R, T, K, E, A, L, V, W, G, C, P, F, D, and S. The two source plans remain useful as design notes; this is the implementation order and acceptance contract.

## Outcome

- Repository and contributor changes stay responsive during a sync. History work scales with changed lines and displayed days instead of repeatedly scanning and transferring full history.
- In **Person** view, a line ownership item represents one GitHub account whenever GitHub provides a reliable match. Its visible label is the same GitHub **login** shown on the Contributors page. A changed login remains one account through its GitHub user ID.
- The `UserFilter` selection is shared with Contributors. Selecting a login on either page selects the corresponding resolved account on Line ownership, including every proven Git author email and name alias attached to that account. `All contributors`, `Just me`, saved selections, and `NO_CONTRIBUTORS` retain their shared meanings.
- Unmatched authors remain visible as clearly identified Git identities; they are never silently assigned to an account because a display name happens to match. Ownership and contribution counts will still differ: surviving lines and GitHub weekly commits measure different things.
- Settings lets the user map an unmatched Git author identity to a verified GitHub account. Automatic GitHub evidence wins; the manual map is checked next; only then does the author remain unmatched. Editing the map updates ownership presentation without changing line attribution.
- Daily values, HEAD reports, exports, co-author credit, cancellation, and crash/restart behavior remain correct. Any intentional identity or date-semantics correction is reviewed and tested separately from performance changes.

## What the current code does

- Contributors uses `listContributors` and `contributor_weeks`, groups logins case-insensitively, displays the login, and reads shared `selectedLogins` through `useScope` (`src/lib/db/queries.ts`, `src/pages/Contributors.tsx`, `src/lib/hooks.ts`).
- Line ownership already uses the same `UserFilter` and selection store, but builds its options from ownership reports. `aggregateOwnership` merges matching Git names as well as emails and account mappings; the history path filters author rows **before** resolving people (`src/lib/lineOwnership.ts`). Either can disagree with what selecting a GitHub login means on Contributors.
- `github_accounts` contains email-to-GitHub-ID/login matches from the commits API, and GitHub noreply addresses can identify an account. Those are stronger evidence than a matching Git display name. The current UI does not have a guaranteed account match for every Git author.
- The page reloads snapshots, history, and accounts every five seconds during sync (`src/pages/LineOwnership.tsx`). History carries author JSON per commit and sends the full checkpoint through the WebView. Rust recalculates first-parent history under a global calculation mutex (`src-tauri/src/line_ownership.rs`).

## Identity and selection contract

1. **Canonical key.** Resolve an author to `github:<user_id>` when an email is linked by `github_accounts` or a numeric-ID GitHub noreply address. Extend account metadata collection to retain GitHub ID and current login together; the existing `contributors` table has logins but no ID, so it cannot by itself resolve a rename. Display the current login that Contributors displays when those records match, otherwise the best known mapped login, and refresh renamed accounts by ID when GitHub supplies one. Match logins case-insensitively. An ID-less noreply login can match a known account login, but keep it provisional until an ID is known; never merge two different IDs solely because their logins or names match.
2. **Evidence for joining.** Resolve by proven GitHub ID first, then a user-supplied manual mapping for an otherwise unmatched raw identity, then leave it unmatched. Merge raw Git identities with the same normalized email or resolved GitHub account ID. A shared name may help display or search, but must not merge distinct emails or accounts without corroborating evidence. If one email maps to conflicting GitHub IDs, keep it unresolved and expose the conflict for diagnosis rather than guessing; allow a manual mapping only after the conflict is explicitly reviewed in Settings.
3. **Unmatched people.** Keep unmatched authors as separate, stable Git identities, preferably keyed by normalized email and otherwise by name plus repository context. Label them as unmatched in the Person selector/table/legend. Do not create a fake GitHub login or profile link. Account matching can improve on later syncs without rebuilding line attribution.
4. **Selection.** Resolve the identity graph first, then select whole canonical people by the shared `selectedLogins` set. A selected GitHub login includes all proven aliases of its ID in snapshot totals, repository rows, daily history, chart series, and exports. Empty selection means everyone; `[NO_CONTRIBUTORS]` means nobody. Keep Email and Name grouping available for diagnosis, but contributor selection is still by resolved person before presentation grouping.
5. **Selector inventory.** Make the Line ownership `UserFilter` show matched accounts with exactly the login used on Contributors, one option per account. Also show unmatched owners with an explicit label and a stable selectable token that cannot collide with a GitHub login. The shared selection may yield no results on Contributors for an unmatched Git identity; that page's filter must display a readable `Unmatched Git identity` selection and offer Clear instead of exposing the internal token. Preserve bot detection and saved selections. If a selected login has no attributable surviving lines in the chosen repositories, show an empty result rather than silently switching to an unmatched namesake.
6. **Co-authors.** Credit each resolved person once per physical line, including when author and co-author aliases resolve to the same account. Different co-authors can make credited lines exceed physical surviving lines. Distinguish physical-line and credited-line totals throughout.

Before implementation, capture fixture outputs for current identity behavior. The account-aligned behavior above is an intentional semantic change; compare and document its differences instead of demanding byte-identical old output for those cases. All unrelated attribution remains parity-checked.

## Staged work

| Stage | Deliverable | Gate |
| --- | --- | --- |
| 0 | Reproducible baseline and correctness fixtures | Representative data and packaged-app timings recorded |
| 1 | Account-aligned identity, Settings manual mapping, and immediate UI fixes (I, R, A) | Cross-page selection and mapping fixtures pass |
| 2 | Per-repository loading and event refresh (K, E) | A changing repo does not reload unchanged repos |
| 3 | Event sweep and bounded rendering (T, L, V, W) | Exact table/export values and responsive chart |
| 4 | Cheaper, durable sync engine (G, C, P) | Parity and crash/restart tests pass |
| 5 | Forward replay and daily output (F, D) | Blame equivalence gates pass before defaulting |
| 6 | Compact daily storage (S) | Migrated and fresh histories agree |

Stages 2 and 3 can proceed independently after the identity contract is implemented. Stage 4 should remove repeated work before raising concurrency. Ship each stage separately and remeasure; projected gains from overlapping changes are not additive.

### Stage 0 — Baseline and fixtures

- Add `scripts/bench-line-ownership.mjs` and `npm run bench:line-ownership`, using a **copy** of representative local data. Record repository/commit/day/author counts, database and IPC bytes, machine details, warm/cold medians, and output checksums. Keep personal data and copied databases out of Git.
- Measure SQL and JSON parse, identity resolution, contributor filtering, period projection, and desktop input-to-paint for each control, including sync in progress. Use React Profiler and Web Inspector for rendering, since a Node benchmark cannot measure WebView paint.
- Add an ignored Rust history benchmark on small, long-lived, and merge-heavy cached clones. Count Git processes by command, blame time, checkpoint bytes, wall time, and peak memory.
- Build fixtures for account IDs, login renames/casing, one person with multiple emails, two people with the same name, unmatched authors, manual mappings and their removal, conflicting mappings, noreply addresses, bots, no selection, `NO_CONTRIBUTORS`, and co-authors. Compare the same selected login across Contributors' filter, the Line ownership selector, summary, history, and export. The figures need not be numerically equal across products; the selected account identity must be.

### Stage 1 — Identity and immediate UI fixes

- Extract a shared, testable ownership identity resolver for snapshots and history in `src/lib/lineOwnership.ts` (or a dedicated module). Keep the raw Git identity, resolved GitHub ID, current login, aliases, match source (automatic/manual/unmatched), and unmatched status distinct. Key caches by repository history/snapshot revision, automatic-account revision, manual-map revision, and identity-rule version. Invalidate when account matches, manual mappings, or current logins change.
- Intern repeated author tuples. Use union-find with path compression and union by size; remove repeated array spreading. Preserve line totals when interning and deduplicate co-author credit per resolved person. Use the same resolver for `aggregateOwnership`, `contributorsFromOwnership`, and history preparation, rather than maintaining different account rules.
- Split history identity resolution from selected-person projection. Repeated contributor changes must not rerun the full author-row union pass. Tests cover selecting/deselecting repositories in different orders, account rename, and a mapping added after a history load.
- Turn off animation for the ownership history chart through a history-specific prop. Keep other charts' behavior unchanged. Measure the effect separately from identity preparation.

### Stage 2 — Load and refresh only changed repositories

- Query reports and daily history per repository with keys that include durable snapshot/history revisions. Keep parsed results in a bounded cache; adding one repository fetches only that repository. Return a small report column for the page instead of repeatedly extracting a multi-megabyte HEAD snapshot.
- Remove `syncing` from the full-data query keys and stop five-second full refetches. Emit repository-specific events after durable writes; invalidate the affected report/history revision and the account map only when it changes. Use a cheap revision/status poll on app resume or as recovery from missed events.
- Preserve the last successful chart while a repository is updating, cancelled, or failed. Never show a partially deleted full-rebuild generation as complete. Inspect the current daily SQL query plan and add an index if needed until compact storage replaces it.

### Stage 3 — Sweep and render at useful resolution

- Convert each repository's sorted daily snapshots to person deltas, then sweep event days while carrying totals. Preserve empty-day carry, UTC boundaries, per-period differences, peak-based ranking, shares, and `Other`. Keep exact daily levels for tables, exports, and lookup.
- Bound chart marks to the visible width and brush range. Coarsen **only the plotted representation** when needed, label the effective date bucket, and restore day detail on zoom. Preserve extrema and negative period changes; tooltips must identify the exact point or displayed aggregate. `All` remains all requested series unless a visible, documented cap is explicitly chosen in the UI; never silently fold extra series.
- Benchmark bounded Recharts first. If it remains slow, prototype one SVG path per series for ownership history, with matching axes, stacked/overlaid modes, bars, theme, brush, tooltip, legend, keyboard/accessibility behavior, and export lookup. Use Canvas only if measured density warrants it. Maintain one default renderer after comparison.
- Move remaining expensive identity/sweep work to a dedicated Worker only if packaged-app input-to-paint improves after the preceding changes. Send per-repository data once, use request IDs to discard stale results, and measure transfer cost.

### Stage 4 — Remove repeated Git work and make checkpoints durable

- Build the first-parent schedule, alias index, repository/options checks, and co-author metadata once per pinned target instead of once per 25-commit batch. Carry tree metadata through safe diffs with a full-tree fallback. Reuse untouched file data and update totals from changed files. Keep cancellation checks and bounded subprocess output.
- Keep the live walk in Rust. Persist a versioned native checkpoint at bounded intervals and return compact progress/results, not the full cache through the WebView. Separate the small HEAD report from its native file cache.
- Make checkpoint publication and SQLite history/cursor updates a crash-safe handoff: atomically write/rename the checkpoint file, then commit points and its pointer/cursor in one SQLite connection/transaction. Keep the previous checkpoint until that transaction succeeds. A JavaScript sequence under `withWriteLock` is serialized but is not itself one SQLite transaction across pooled plugin connections.
- Replace the single calculation mutex with a measured repository semaphore and global Git-process/memory limits. Coordinate with the existing sync pool, isolate repository failures, and choose the default permit count from laptop throughput and peak-memory measurements.

### Stage 5 — Replay diffs, retain blame as the oracle

- Maintain compact per-file surviving-line origins and person credits while processing **every** first-parent commit. Whitespace-only edits, renames, copies, restores, binary/mode changes, generated exclusions, `.mailmap`, and co-authors must match the existing blame rules. Re-blame affected files on merges and uncertain cases. Keep exact HEAD scanning as fallback and reference.
- Emit one daily point per repository/day while retaining an exact pinned HEAD state. Do **not** assume that walk order and committer date order agree. The current SQL chooses a day's point by `datetime(committed_at) DESC, revision DESC`; a clamp to monotone walk days would change output. Either reproduce that rule exactly, including out-of-order timestamps and equal-time ties, or make a separately reviewed date-semantics change with a migration and user-visible explanation. Process intervening commits even when only daily points are saved.
- Ship replay behind an engine switch. Compare per-commit person totals on generated Git fixtures and daily series plus HEAD reports on representative real clones against `scan_snapshot_at`. Verify split/resumed walks, force pushes, cancellation, and a crash at each persistence boundary. Default to replay only after parity and measured gains; retain blame fallback and the reference tests.

### Stage 6 — Compact storage without losing verified history

- Store versioned daily points and sparse deltas with a separate **raw identity** table and account-resolution layer. Do not bake a canonical person ID into historical rows without an invalidation/remapping path: new GitHub matches can join aliases, and a login can change. Keep total/co-authored counts and indexes on `(repo_id, UTC_day)`.
- Add an idempotent schema migration that reads the old schema version before changing it. Existing `authors_json` may already have merged distinct Git identities, so it cannot always be losslessly converted to raw identities. Keep legacy history readable while replay rebuilds it into the new format; compare physical totals and attribution where recoverable, then switch each repository only after its new generation passes verification. Keep old data until verification passes. Make a crash mid-rebuild safe.
- On batch writes, account for a batch ending within a day. Make daily deltas, daily totals, checkpoint pointer, and cursor advance atomically. Verify database bytes, query time, IPC bytes, and memory before/after.

## Release gates

1. Run `npm run check`, focused TypeScript identity/selection/history tests, and Rust history tests for the stages they affect. Do not use a timing assertion in normal CI unless its environment is stable; use the benchmark harness for performance comparisons.
2. Compare exact HEAD reports, per-repository/day totals, co-author totals, selected-account series, CSV/JSON output, and the current blame engine on fixtures and varied real repositories. Record intentional account-identity differences separately.
3. Profile the packaged desktop app idle and during an organization sync. Record median and high-percentile input-to-paint latency, full/incremental sync time, Git command count, memory, checkpoint/IPC bytes, and database size. Targets from `performance_plan.md` are goals to validate, not promised outcomes.
4. Kill and restart sync around every checkpoint/database handoff, including full rebuild and migration. No incomplete generation may be marked done; the previous successful report remains readable.
5. Ship independent stages only when their measured benefit and correctness gate pass. Remove experimental Worker/renderer paths that do not improve the packaged app.

## Implementation specification for handoff

The sections below turn the stages into changes that can be assigned as separate PRs. File names describe the current tree; adjust names if a refactor moves code. Check the current implementation before using line numbers from either source plan.

### 0.1 Benchmark command and output

Add `scripts/bench-line-ownership.mjs` using the same esbuild/`node:sqlite` setup as `scripts/test-line-ownership.mjs`. Its database argument must be a copied database path; make the script refuse the live application database path. Print JSON plus a concise table containing:

```text
dataset: repo_count, first_parent_commits, repo_days, raw_author_rows,
         distinct_emails, matched_github_ids, unmatched_identities, db_bytes
query:   history_ms, history_bytes, snapshot_ms, snapshot_bytes, json_parse_ms
ui:      identity_ms, selection_ms, daily_sweep_ms, bucket_ms, plot_input_points
sync:    wall_ms, ms_per_commit, git_processes_by_type, blame_ms,
         checkpoint_bytes, ipc_bytes, peak_rss_bytes
```

Use at least five runs per stable microbenchmark and report median and range. Keep an output-equality mode for attribution and chart arrays. Include small, long-lived, and merge-heavy repositories; pin their HEAD SHAs in the benchmark metadata. Desktop measurement uses a development-only React Profiler and `performance.mark` around identity, projection, and chart render, plus a Web Inspector timeline for actual input-to-paint. Measure repo, contributor, period, reading, shape, split, and `All` changes while idle and while syncing. Record a baseline in the PR rather than checking machine-specific milliseconds into a failing CI assertion.

### 1.1 Ownership account model

Add a pure resolver module, for example `src/lib/ownershipIdentity.ts`, with an interface along these lines:

```ts
type PersonKey = `github:${string}` | `unmatched-email:${string}` | `unmatched-name:${string}`;
interface RawIdentity { name: string; email: string; repoId?: number }
interface ResolvedPerson {
  key: PersonKey;
  githubId: string | null;
  login: string | null;
  label: string;
  matched: boolean;
  names: string[];
  emails: string[];
  selectionTokens: string[];
}
interface OwnershipIdentityIndex {
  personOf(raw: RawIdentity): PersonKey;
  people: ReadonlyMap<PersonKey, ResolvedPerson>;
  personForSelection(token: string): PersonKey | null;
}
```

The actual API may use integer indexes for speed. Its semantics matter more than these types:

1. Normalize emails by trim/lowercase, names by trim/collapse-space/lowercase, and logins case-insensitively. Keep display casing separately. An empty email is never a global join key.
2. Resolve numeric-ID noreply emails and `github_accounts` entries to a GitHub ID. Do not let an ID-less noreply login override a conflicting known ID. If an email has contradictory mappings, mark it conflicted and require explicit review. For otherwise unresolved identities, consult the manual mapping described below before producing an unmatched key.
3. Join by GitHub ID or equal nonempty normalized email. If an email links two GitHub IDs, stop the join and report the conflict. Do not join on equal names alone; the current name-based merge is precisely what can turn two real GitHub accounts into one ownership item.
4. For an unmatched email, use `unmatched-email:<normalized email>`; for a nameless/email-less identity, use a deterministic repository-scoped key to avoid merging unrelated people. The visible label should say `Unmatched: ...`, but the token saved by the shared selector must be an internal prefixed key. The Contributors page may have zero rows for that token, and the UI should say so.
5. Return canonical people first, then apply selection. If the selected array is empty, include all; if it contains `NO_CONTRIBUTORS`, include none. For a GitHub login, resolve its account ID and include all its raw identities. For a saved old login, use the ID/rename alias map so it still selects the same account after a rename. Do not treat a bare Git name as a login match.
6. Labels for matched accounts are their current GitHub logins. Since `contributors` currently has no GitHub ID column, add a small account registry keyed by ID, populated from the commit API match, manual target lookup, and refreshed from GitHub when practical. Join that registry to Contributors' login metadata. Do not claim a current login merely because a stale email mapping contains it. Keep the best known login as an offline fallback.

`src/lib/lineOwnership.ts` currently has separate joining/filtering paths: `aggregateOwnership`, `prepareOwnershipHistory`, `historyAuthorMatches`, `linkedAccount`, and `contributorsFromOwnership`. Route them through the resolver. In `aggregateOwnership`, apply the selected-person set to each credit **before** Email/Name presentation grouping, then deduplicate the people in that credit. Build the Line ownership `UserFilter` list from resolved people: account options use the same login as Contributors; unmatched options are explicit. Preserve `NO_CONTRIBUTORS`, bot rules, and stored selections in `src/components/UserFilter.tsx` and `src/lib/contributorSelection.ts`.

The account lookup/cache needs its own revision. `writeGithubAccounts` currently stores one row per email, including null misses, and `matchGithubAccounts` skips known emails on incremental sync. Add a bounded refresh strategy for stale login mappings and newly resolvable misses, with rate-limit/error handling. A failed refresh keeps the last known attribution and label; it must not prevent local Git history sync.

**Identity examples to assert in tests:**

| Git evidence | Expected Person item and selection |
| --- | --- |
| Two emails map to GitHub ID 42, current login `alex` | One `alex`; selecting `alex` includes both emails |
| Login `oldalex` becomes `alex`, ID stays 42 | One `alex`; saved `oldalex` selection still finds ID 42 |
| Two emails say `Alex Smith` but map to IDs 42 and 99 | Two account items; selecting one does not include the other |
| Email has no GitHub match | One clearly unmatched item; selecting `alex` cannot include it by name |
| Unmatched email manually mapped to ID 42 | It joins `alex`; selecting `alex` includes its lines |
| Automatic ID 99 is later found for a manually mapped email | ID 99 wins; Settings marks the manual row as superseded |
| Author and co-author aliases both map to ID 42 | One credit for ID 42 on each line |
| Author ID 42 and co-author ID 99 share a line | One credit for each; credited total may exceed physical total |
| `[NO_CONTRIBUTORS]` | Empty summary, chart, table, and export without changing stored raw data |

### 1.1a Manual mappings in Settings

Add a **Line ownership contributor mappings** section to `src/pages/Settings.tsx`. It lets the user review unmatched Git authors and create, edit, and remove a mapping to a GitHub account. An unmatched row shows the Git name, email if present, affected repository count, surviving lines, and whether history is fully account-resolved. Search by name/email. The target picker lists known GitHub accounts with the same login labels as Contributors. Allow a login absent from the local contributor list by looking it up through the authenticated GitHub API and storing its immutable user ID. Show login and ID before saving. Offline, allow choosing an account whose ID is already cached; require online verification before saving a newly typed login. A typed login alone is not a durable identity.

Use an explicit scope so a common name does not map unrelated people:

```sql
CREATE TABLE ownership_manual_account_map (
  mapping_id INTEGER PRIMARY KEY,
  match_kind TEXT NOT NULL,       -- email | repo_name
  match_value TEXT NOT NULL,      -- normalized email or normalized Git name
  repo_id INTEGER,                -- NULL for email; required for repo_name
  github_id TEXT NOT NULL,        -- verified immutable GitHub user ID
  login_at_save TEXT NOT NULL,
  reviewed_auto_conflict INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ownership_manual_email_unique
  ON ownership_manual_account_map(match_kind, match_value)
  WHERE repo_id IS NULL;
CREATE UNIQUE INDEX ownership_manual_repo_name_unique
  ON ownership_manual_account_map(repo_id, match_kind, match_value)
  WHERE repo_id IS NOT NULL;
```

Add a mapping revision in `meta` or a dedicated one-row table, incremented in the same transaction as each edit. Migrate with the schema version rather than assuming `CREATE TABLE IF NOT EXISTS` alters existing databases.

**Matching order and scope:**

1. A verified, unambiguous automatic GitHub ID from the commit API or numeric-ID noreply address wins. A manual row for that source remains visible in Settings as `Superseded by automatic match`; it does not rewrite the automatic mapping. If automatic evidence conflicts, show `Conflicting automatic matches`; applying a manual choice requires the user to review that conflict, recorded by `reviewed_auto_conflict`. The choice applies only to that exact source and remains visibly manual.
2. Otherwise check a normalized exact-email manual row. This applies across repositories. An exact email is the default mapping action and is shown as `All repositories with this email`.
3. If the raw identity has no usable email, check an exact normalized-name row scoped to a single repository. Show that narrow scope prominently. Do not offer a global name-only mapping or fuzzy/substring match.
4. Otherwise keep the raw identity unmatched. The map is a presentation identity layer: it never changes Git blame origins, commit authors, or physical line counts.

When the user saves a mapping, recompute matched people, labels, summary, selector, history projection, and exports from raw attribution; emit a mapping revision event and invalidate those caches. The shared selected-login store still holds logins, so a mapped author's lines appear under the target account when that login is selected on either page. Removing the map returns those lines to an unmatched item, including co-author credit deduplication. Show mapping source (`GitHub` or `Manual`) in an optional details view so a user can audit why an author belongs to an account.

The old `line_ownership_history.authors_json` may already have combined raw identities. For a legacy point that cannot be split safely, do not pretend a manual map precisely reassigns only one email's lines. Apply it to the current HEAD snapshot if raw credits are present, label legacy history as awaiting rebuild, and queue that repository for the Stage 5/6 replay rebuild. Newly written history should preserve raw identities so mapping edits immediately reproject it without rerunning Git. A mapping edit does not delete old history or interrupt sync; it changes the account index revision and later rebuild state.

**Settings tests:** create/edit/delete; same email in two repositories; same name with two emails; name-only mapping limited to one repository; login rename with constant ID; typed unknown login verified through GitHub; cached-ID choice while offline; automatic match superseding manual; reviewed conflicting automatic evidence; mapping an author/co-author to an account already on the same line; undo restoring unmatched state; app restart and saved selection. The UI should show a concrete preview such as `This maps 3 Git identities and 1,240 credited surviving lines to @alex`, with the count derived from current cached snapshots, before Save.

### 1.2 Identity performance and reuse

The history join currently creates a row per distinct parsed author object, walks deep union chains without compression, and repeatedly spreads member arrays. Intern a stable tuple of normalized author/names/emails, map source rows to interned IDs, use path halving and union by size, and append member indexes in place. Preserve line weighting for labels and totals; do not sum one carried object once per empty day. Add a targeted test with many daily repetitions of a few identities, but benchmark its time outside CI.

Split `prepareOwnershipHistory` into:

```ts
normalizeRepoHistory(pointsForRepo): NormalizedRepoHistory
resolveOwnershipPeople(histories, accountIndex): OwnershipIdentityIndex
selectOwnershipPeople(identityIndex, selectedLogins): ReadonlySet<PersonKey>
projectOwnershipHistory(histories, identityIndex, selection, options): HistorySeries
```

Normalize each repository once per history revision. Rebuild the small interned cross-repository identity graph when selected repositories or account mappings change; an incremental union graph cannot safely remove a repository that supplied a bridge. Contributor, period, split, and shape changes reuse the graph. Snapshot and history use the same identity resolver version, and an account-map update invalidates both presentations without rerunning Git blame. Compare results with the old implementation wherever identity semantics have not intentionally changed.

### 2.1 Per-repository queries and notifications

In `src/pages/LineOwnership.tsx`, replace the selected-repo aggregate query with a small revision/status probe and per-repository report/history queries. A concrete React Query key shape is:

```ts
["line-ownership-revisions", sortedRepoIds]
["line-ownership-report", repoId, snapshotRevision]
["line-ownership-days", repoId, historyGeneration, historyRevision]
["ownership-account-index", accountRevision]
```

Use `useQueries` for selected repositories and combine results without replacing unchanged repository objects. Bound cache lifetime or memory by measured size. Query the report directly from a separate column once Stage 4 adds it; until then, avoid transferring the full snapshot cache and measure the `json_extract` cost. A missing repository contributes no points and has its own loading/status indicator.

Add an `ownershipEvents` publisher at durable write boundaries in `src/lib/ingest/lineOwnership.ts` and account matching. An event should identify `{repoId, kind, revision, generation}`. History batches can throttle UI refresh to a measured interval; repository completion refreshes immediately. Account-map events invalidate the global identity index and any visible account labels. Keep a cheap revision poll for app resume, missed events, and external database changes. Remove `syncing` from full-data query keys and the five-second history/snapshot/accounts reloads. Preserve the last complete generation while full resync builds a replacement.

**Acceptance:** selecting another cached repository does not reparse other repositories; one repo finishing a sync does not transfer all selected history; cancellation leaves the previous successful report visible. Record cold-load time and cache memory as well as warm filter latency.

### 3.1 Event sweep and data contract

Add `src/lib/ownershipHistory.ts` with pure functions. Convert each repository's daily full levels to sorted `{day, rawIdentityOrPerson, delta}` events; include negative deltas when an owner disappears. Resolve those raw identities through the account index, then k-way merge repositories' events by UTC day. Keep current level by person and repository and emit the aggregate at the end of each day. Carry values through calendar days without iterating each repository's full author list. For per-period reading, subtract the preceding period-end level, with the first period measured from zero. Track each series' peak at every day for ranking, so a coarser display bucket does not change `Other` membership.

The output should distinguish `fullRows` (the selected exact period for table/export/lookup) from `plotRows` (possibly coarsened for paint). Do not compute shares or person totals from already coarsened points. Test Day/Week/Month/Quarter, cumulative and per-period, people/repository/total split, negative changes, co-authors, no-commit days, multiple commits per day, and repository selection order. Use the old projection as an oracle only for cases whose identity/date semantics remain unchanged.

### 3.2 Bounded plot and renderer decision

In `src/components/LineOwnershipCharts.tsx`, pass a history-specific `animate={false}` through `TimelineArea` to its area, line, bar, and brush marks. Measure with current full rows. Next, use a `ResizeObserver` and visible brush range to derive a point budget from actual plot width. Keep the chosen period exact in the table. If a Day plot has too many rows, coarsen plotted periods with an explicit caption such as `Plotted at 7-day resolution; zoom for daily detail`. Tooltip headings show the displayed bucket range. Preserve first/last, extrema, and significant negative changes; verify that cumulative stock values use bucket-end levels and per-period values sum all changes in that bucket.

Benchmark bounded Recharts with 8 series and with `All`. If it still misses the desktop paint target, add a history-only `OwnershipTimeline` that draws one SVG path per series, with geometry cached separately from hover and legend state. It needs stacked/overlaid area, line, and bar geometry; total and share axes; negative values; tooltip/crosshair; brush/zoom; legend toggles; responsive width; themes; accessible labels and a full-resolution table. Compare it with bounded Recharts on the same fixture. Canvas is a follow-up only if path count or dense bars remain a measured bottleneck. `All` must remain truthful: if performance forces a cap, show the count and `Other` explicitly while the exact table/export retains everyone, and make that product decision visible in the PR.

Only then test a Worker for identity/sweep work. Transfer typed arrays once per repository revision, keep them in the Worker, send small option messages, and discard results with older request IDs. Compare compute plus transfer plus paint to synchronous work; keep a synchronous path for small datasets and tests. Do not add a Worker merely because `useMemo` is synchronous.

### 4.1 Reuse work in the blame engine

In `src-tauri/src/line_ownership.rs`, introduce a `WalkContext` for one `(repository, pinned target, scan options)`:

```rust
struct WalkContext {
    target: String,
    commits: Vec<WalkCommit>,       // first-parent schedule, oldest first
    aliases: IdentityIndex,
    coauthors: HashMap<String, Vec<Identity>>,
    // repo capabilities, path exclusions, and tree metadata
}
struct WalkCommit {
    sha: String,
    first_parent: Option<String>,
    committed_at: i64,
}
```

Build it once per job with one first-parent log, not once per 25-point `advance_history` batch. Cache co-author bodies and Git capabilities. Carry a tree map forward with `diff-tree` for changed paths; use the existing full-tree scan when a change cannot be classified safely. Share unchanged file counts instead of deep-cloning them, and update commit/person totals by subtracting old changed-file counts and adding new ones. Keep `scan_snapshot_at` as the correctness oracle and as the fallback for uncertain cases. On a rewritten default branch or changed options, invalidate context and checkpoint. Count every Git command by type before and after this stage.

Do **not** implement the old plan's daily-endpoint shortcut as a separate blame-engine optimization until its date and intervening-path semantics pass fixtures. It may save work, but a wrong endpoint or change-and-revert within a day can silently change chart values. Forward replay in Stage 5 is the preferred way to process all commits cheaply and persist fewer points.

### 4.2 Native checkpoint protocol

Replace the `ownershipHistoryCache` loop in `src/lib/ingest/lineOwnership.ts` and `writeOwnershipHistory` in `src/lib/db/lineOwnership.ts` with a Rust-owned job that holds its working state in memory. A batch response contains points or days, `cursor`, `target`, `generation`, `done`, and progress; it does not contain serialized file state. Persist a versioned native checkpoint under the app cache directory at a bounded time/size interval. A suggested header is `{format_version, engine, repo_id, target, options_hash, cursor, checksum}` followed by compact state; reject mismatches and corruption explicitly.

The commit protocol is:

1. Write checkpoint `generation/cursor.tmp`, flush it, atomically rename to an immutable checkpoint name, and keep the previous checkpoint.
2. In **one SQLite connection and transaction**, insert or replace the durable history points and update the history-state row with that checkpoint name, cursor, target, and generation. Commit only after all statements succeed. A pooled JavaScript `withWriteLock` sequence is insufficient for this transaction.
3. After commit, publish the history revision event. Clean orphan checkpoint files later. A crash before the DB commit leaves the previous DB pointer and checkpoint valid; a crash after commit finds the new immutable checkpoint.
4. On startup, validate the referenced file/header/checksum. If it is absent or corrupt, retain the last successful visible generation and rebuild into a new generation. A reset must not silently mark history complete.

Move the HEAD per-file cache behind a native reference and store the small report, revision, and options visibly in SQLite. Continue serving the old successful report while a new full scan is in progress. Version snapshot/cache formats and support one-release legacy conversion or a controlled rebuild. Use a single-writer strategy coordinated with the existing WAL database. Add kill/restart tests at every boundary, not just a clean checkpoint round trip.

### 4.3 Bounded concurrency

Replace `ScanControl.calculation`'s single global mutex with a small semaphore. Start with two active repositories, then benchmark one through four slots on representative hardware. Cap total Git/blame subprocesses and memory across repositories; the current per-repository worker count cannot remain unchanged when multiple repositories run. Coordinate with `pool(ownershipTargets, 2, …)` in `src/lib/ingest/sync.ts` so the JS pool can actually feed the native permits. Make permit acquisition cancellation-aware. A failed or cancelled repository must release its permit without cancelling another. Serialize SQLite writes through the native writer. Keep the default permit count that improves full-org wall time without delaying chart interaction or causing a large RSS spike.

### 5.1 Forward line-origin replay

Add a replay module behind an explicit `Blame | Replay` engine choice. Its checkpoint stores the pinned target/options, current first-parent cursor, per-file blob/mode/classification, one compact origin ID per surviving text line, an interned commit/identity table, per-origin line counts, raw attribution, and daily emission state. Use a streaming first-parent patch or equivalent diff traversal. Pin diff options required to match the existing `blame -w` behavior; parse file modes, renames, deletions, additions, binary transitions, and no-newline markers. For each hunk, preserve origins of unchanged lines, remove deleted origins, and assign new lines to the proper commit. A patch hunk is not automatically equivalent to blame: whenever placement, whitespace, copy, or file classification is uncertain, re-blame that file and record the fallback reason.

Merge commits need special handling because a first-parent diff can attribute lines from a side branch to the merger. Re-blame affected text paths at that merge SHA, import the side-branch origin commits and co-author metadata, and rebuild the per-file owner sequence. Treat `.mailmap` or scan-option changes as a versioned remap/rebuild trigger. A legacy checkpoint with no line-origin state should bootstrap from blame, not be interpreted as replay state. Keep `sync_line_ownership` and `scan_snapshot_at` as independent references through rollout.

Store raw origin identity separately from the current `PersonKey`. Applying a new GitHub or manual mapping must regroup existing raw credits without changing which commit owns a line. Co-author deduplication happens after identity resolution; a mapping can turn two raw co-authors into the same account. If the compact checkpoint also caches grouped person totals for speed, tag them with the account/manual-map revision and recompute on mismatch. Do not reset Git history merely because the display account grouping changes.

**Replay fixture matrix:** whitespace-only edits; insert/delete/replace; rename plus edit; copy if supported; delete then restore; merge side-branch lines; generated/binary/symlink/submodule changes; `.mailmap`; CRLF and no final newline; co-author trailers; duplicate author/co-author account; multiple Git identities later manually mapped to one account; force push; cancellation; resume at random cursors; large hunks. At every fixture commit compare raw surviving-line origin counts and the HEAD report with a full blame scan. Compare representative real repository reports field by field and log every fallback frequency before making replay the default.

### 5.2 Daily emission without changing the meaning of a day

The current `ownershipHistory` query partitions by `date(committed_at)` and chooses `ORDER BY datetime(committed_at) DESC, revision DESC`. Its selected commit is **not necessarily the last commit encountered in first-parent walk order** when timestamps go backwards. Store each day's candidate revision, timestamp, tie-break revision, and its exact raw ownership levels; replace that candidate when the SQL ordering says a new commit wins. Continue replaying all commits in walk order for the correct next state. A day may need an upsert late in the walk if an out-of-order commit becomes its winner. Verify that a batch ending mid-day and a restart produce the same final day row as a single uninterrupted walk. Keep the pinned HEAD state separate from whichever day candidate won.

Persist one selected point per UTC day only after its value and candidate metadata are durable. If the history is shown during a partial walk, mark the generation as partial and avoid presenting its latest day as final. Test equal timestamps with revision tie breaks, dates crossing UTC midnight, nonmonotone dates, multiple commits on one day, change then revert, merges, and a rewritten branch. A proposed change to the daily rule must be a separate product decision, not an incidental performance optimization.

### 6.1 Storage schema and migration sequence

The final history format should preserve raw ownership, daily candidates, and efficient projection. One possible logical schema is:

```sql
-- Raw identity IDs are stable within a repository generation; account resolution
-- is a separate versioned join, including manual overrides.
line_ownership_raw_identity(repo_id, generation, raw_id, name, email)
line_ownership_day(repo_id, generation, utc_day, chosen_revision,
                   committed_at, total_lines, coauthored_lines)
line_ownership_day_delta(repo_id, generation, utc_day, raw_id, delta_lines)
line_ownership_history_state(repo_id, generation, target, cursor,
                             checkpoint_ref, status, revision)
```

The SQL above is a shape, not copy-paste DDL. Define primary keys, foreign keys where feasible, and a covering `(repo_id, generation, utc_day)` index in the migration. Daily levels are prefix sums of raw deltas. Preserve physical total/co-authored totals separately from credited raw identity deltas. A line with multiple co-authors needs enough raw provenance to deduplicate again when two identities later map to one account; simple independent per-author totals cannot always recover that. Store a compact credit-group/origin representation or trigger a replay-derived regroup of raw origin state on identity revision changes. Prove this with the author-and-co-author-merge fixture before finalizing the schema.

`src/lib/db/index.ts` currently runs `SCHEMA_SQL` and then writes `SCHEMA_VERSION` without reading the previous version. Add ordered, idempotent migrations before updating the version. Introduce a new history generation per repository. Existing `authors_json` can be displayed as legacy history, but it may have irreversibly merged two raw people by name. Build the new generation from replay, compare physical totals and all recoverable attribution against the old path, and switch the visible generation atomically only after it reaches the pinned target and passes validation. Do not drop old rows at migration start. Keep an old generation until the new one is verified; collect it later. A cancelled or crashed rebuild resumes or restarts its new generation while the old chart remains readable.

On each batch, write raw identities, daily candidate replacements/deltas, cursor, and checkpoint pointer in the same native SQLite transaction. If a batch ends mid-day, recompute or upsert that day's delta from the prior durable level; never add the same partial delta twice on retry. Carry a unique batch/generation sequence or write idempotent absolute levels before deriving deltas. Read one repository at a time, in day order, and transfer compact IDs/deltas rather than repeated names and emails. Measure database size, query time, parse time, IPC bytes, and account-remap time against the baseline.

### PR order and exit checks

| PR | Scope | Exit check |
| --- | --- | --- |
| 0 | Benchmark harness and parity fixtures | Baseline captured on copied data and packaged app |
| 1a | Account registry, raw identity resolver, and cross-page selection | Same GitHub ID has one login/item; namesakes remain separate |
| 1b | Settings manual mappings and revision invalidation | Create/edit/delete changes HEAD and eligible history projection immediately |
| 1c | Interned identity join, reuse, animation off | Correctness fixtures pass; filter interaction improves |
| 2a | Events and revision/status probe | Sync stops full five-second reloads |
| 2b | Per-repository report/history loading | Adding one repo does not reload others |
| 3a | Event sweep and plot budget | Exact table values, bounded chart marks |
| 3b | Renderer/Worker only if benchmarks justify them | Packaged app paint improves with feature parity |
| 4a | Reused Git context/tree/aggregation | Same blame output with fewer Git processes |
| 4b | Native checkpoint and atomic DB handoff | Crash/restart boundary matrix passes |
| 4c | Repository concurrency | Org sync faster within memory/CPU bounds |
| 5a | Replay behind engine switch | Per-commit blame parity and real-repo report parity |
| 5b | Daily candidate emission | Same UTC-day query results and resume behavior |
| 6 | Raw daily storage and generation migration | Manual remapping is exact; legacy data retained until verified |

The early account/manual-map PRs can make current HEAD reporting correct immediately. They can only make legacy history exact where its saved rows still distinguish the raw authors. Mark ambiguous legacy history clearly and complete the replay rebuild before claiming full account-aligned historical parity. Keep the source plans as deeper rationale for individual implementation ideas, but use the contracts and gates above when the two plans disagree.
