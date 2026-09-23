# Line Ownership Performance Plan

This plan turns the seven model reviews in `performance_improvement.md` into an ordered implementation plan. It covers every option in that document's comparison table (codes **I, R, D, F, G, P, C, S, K, E, L, A, V, W, T**) and includes the implementation detail for each.

References point at the code as of `333c717`.

---

## 1. What we're fixing

### 1.1 Baseline (measured by the reviews on the local database)

| Area | Measurement | Source |
| --- | --- | --- |
| UI: `prepareOwnershipHistory` with no contributor filter | **3.7–3.9 s**, 85% in `find()` | Opus Medium/High, Astra, Fable |
| UI: same function with path compression + no array spread | 230–250 ms, identical output | Opus, Astra |
| UI: same function with author tuples interned (799 distinct of 126k rows) | 330 ms, identical output | Fable |
| UI: history SQL (window function) | 150–690 ms, returns 15–16 MB `authors_json` | several |
| UI: snapshot SQL (`json_extract` of report from multi-MB snapshot) | ~190 ms + IPC | Opus High |
| UI: bucket / period / cumulative maths | 1–2 ms (**not the problem**) | Astra |
| UI: chart | 2,982 daily points × 9 series, animated for 1.5 s; Bars ≈ 27k SVG rects; "All" ≈ 388k points | Opus High |
| UI: while syncing | Snapshots, history and accounts all refetch every 5 s (≈ 20 MB) and the whole pipeline reruns | all |
| Sync: history walk per first-parent commit | **~180 ms/commit**, of which ~110 ms is ~10 fixed `git` spawns | Opus High, Fable |
| Sync: whole org | 38,937 first-parent commits, one repo at a time: **~2–3 h** | Opus High, Fable |
| Sync: days actually plotted | 12,076 repo-days of 38,937 commits (3.2× fewer) | Fable |
| Sync: checkpoint round trips | Up to 3.5 MB × 4 hops per 25 commits (≈ 3.4 GB of JSON for one repo) | Fable |
| Sync: single `git log --first-parent -p` over a whole repo | **0.5–2.7 s** | Opus High |

Only 51 of 216 repos have history so far. The UI identity join is quadratic in history rows, so it will get much worse as the rest finish.

### 1.2 Targets

| Interaction | Today | Target |
| --- | --- | --- |
| Change repositories / contributors → chart painted | 4+ s | **< 150 ms** (controls never freeze) |
| Change period / cumulative / shape / split → chart painted | seconds (animation + SVG) | **< 50 ms** |
| Page while a sync is running | continuously busy | idle between repo completions |
| Full org history sync (first time) | 2–3 h | **< 10 min** |
| Incremental sync of an unchanged repo | cheap already | unchanged |
| Incremental sync of a repo with N new commits | N × 180 ms | ~N × 2 ms + one spawn |

---

## 2. Phase overview

Every phase ships on its own and leaves the app correct. The later phases replace parts of the earlier ones on purpose: the early phases fix what's on fire within a few days, and the later phases are the structural fixes.

| Phase | Options | What it gives | Size |
| --- | --- | --- | --- |
| 0. Measurement harness | — | Repeatable before/after numbers | S |
| 1. UI quick wins | **I**, **A**, **E** (event invalidation), **R** | UI goes from ~4 s to ~250 ms, and the page stops thrashing during sync | S–M |
| 2. Sync quick wins | **D**, **G**, **C**, **P** | Sync ~5–15× faster on the existing blame engine | M–L |
| 3. Forward diff replay | **F** | Sync ~50–100×; org history in minutes | L |
| 4. Compact storage and incremental loading | **S**, **K**, **E** (per-repo), **T** | UI cost no longer depends on history length; 16 MB → < 1 MB per load | L |
| 5. Rendering | **L**, **V**, **W** | Redraws in milliseconds; the main thread is never blocked | M–L |

Suggested PR sequence: 0 → 1a (I) → 1b (A) → 1c (E) → 1d (R) → 2a (G) → 2b (D) → 2c (C) → 2d (P) → 3 (F, behind an engine switch) → 4 (S + T, then K + E) → 5a (L) → 5b (V) → 5c (W).

---

## 3. Phase 0: measurement harness

The reviews measured UI prep and sync with ad hoc scripts, and nobody profiled the WebView render. We need the same numbers at every step.

### 3.1 UI pipeline benchmark: `scripts/bench-line-ownership.mjs`

- Use the esbuild + `node:sqlite` pattern from `scripts/test-line-ownership.mjs`.
- Open a **read-only copy** of `~/Library/Application Support/com.adamhiggins.github-monitor/github-monitor.db` (copy it into a temp dir first; never open the live file).
- Time each stage separately, taking the median of 5 runs:
  1. The history query (`ownershipHistory` SQL), plus bytes returned.
  2. `JSON.parse` of `authors_json`.
  3. `prepareOwnershipHistory` with no filter, 1 selected contributor, and 3 selected.
  4. `projectOwnershipHistory` for people, repository and total.
  5. `ownershipHistoryBuckets` for each period and reading.
  6. `ownershipSnapshots` query and `aggregateOwnership`.
- Print a table, and write JSON to the scratch dir so runs can be diffed.
- **Output-equality mode:** serialise the final `{data, series}` for a fixed set of options, and assert it is byte-identical to a stored baseline. Every UI phase uses this as its regression gate.
- Add `npm run bench:line-ownership`. Keep it out of `npm run check`, because it needs local data.

### 3.2 Render timing in the app

- Wrap `HistoryPlot` in `<React.Profiler id="ownership-history" onRender=…>` behind `import.meta.env.DEV`, and log `actualDuration`.
- Add `performance.mark`/`measure` around the `prepared`, `data` and `plotted` memos in `OwnershipHistoryChart`.
- Record a Safari Web Inspector timeline for three interactions: change repo selection, toggle Cumulative/Per period, and switch Day→Month.

### 3.3 Sync benchmark: an ignored Rust test

- Promote the throwaway bench from the Opus High transcript into `#[test] #[ignore] fn bench_history_walk()` in `line_ownership.rs`. It reads `OWNERSHIP_BENCH_REPO`, runs `advance_history` in batches, and prints ms/commit, checkpoint size and points size.
- Point it at 3 cached clones of different sizes: `cin-questionnaire` (small), `fd-symphony` (1.4k commits) and `orchestra` (3.8k).
- Run with `cargo test --release -- --ignored --nocapture bench_history_walk`.

**Done when:** the baseline numbers are committed in a comment block at the top of the bench script, so later PRs can quote before/after.

---

## 4. Phase 1: UI quick wins

### 4.1 [I] Fix the quadratic identity join

**Where:** `src/lib/lineOwnership.ts:286` (`prepareOwnershipHistory`), `:82` (`aggregateOwnership.root`), and `src-tauri/src/line_ownership.rs:345` (Rust `root`).

**Problem:** `rows` is keyed by *object identity*. Every parsed history point creates fresh author objects, so there are ~126k rows for ~200 real people. `union()` always makes the newest row a child of the old root, and `find()` has no path compression, so each person becomes one long chain. On top of that, `members.set(root, [...spread, index])` (line 370) copies a growing array on every row.

**Implementation:**

1. **Intern author tuples before the union-find.** While filling `carried`, map each author object to an interned id:
   ```ts
   const internKey = (a: OwnershipHistoryAuthor) => `${a.author}\u0000${a.names.join("\u0001")}\u0000${a.emails.join("\u0001")}`;
   const internId = new Map<string, number>();
   const interned: Array<{ author: string; names: string[]; emails: string[]; lines: number }> = [];
   const idOf = new Map<OwnershipHistoryAuthor, number>(); // object -> interned id
   ```
   For each distinct source *object* (not each carried day), add `author.lines` to `interned[id].lines`. That keeps the `loginLines` weighting in `preferredLogin` identical to today, which sums lines once per distinct object.
2. Run the union-find over `interned` (~800 rows), not over `rows`.
3. **Path halving plus union by size** (a guard against future growth):
   ```ts
   const find = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
   const union = (l: number, r: number) => { let a = find(l), b = find(r); if (a === b) return; if (size[a] < size[b]) [a, b] = [b, a]; parent[b] = a; size[a] += size[b]; };
   ```
4. **Push, don't spread:** `let list = members.get(root); if (!list) members.set(root, list = []); list.push(index);`.
5. **Memoise `linkedAccount`** per call: `const accountOf = memo(email => linkedAccount(email, accounts))`. It currently runs a regex for every email on every row, twice.
6. The final day loop looks up `keyByAuthor.get(author)`, so it keeps working if you map object → interned id → key.
7. Apply the same compression to `aggregateOwnership.root` (line 82): write `parents.set(key, result)` back along the path.
8. **Rust `root()`:** replace the `BTreeMap<String,String>` chase with an index-based union-find. Intern identity keys to `usize` once, and keep `Vec<usize>` parents with path halving. `aggregate()` runs once per history point, so this matters for sync too.

**Tests:** the Phase 0 equality mode must report byte-identical output. Add a unit test to `test-line-ownership.mjs` with 5,000 synthetic points for 3 people; it must finish in under 200 ms, so a regression fails CI.

**Expected:** 3.7 s → ~0.25 s.

### 4.2 [A] Turn off chart animation for ownership history

**Where:** `src/components/charts.tsx:260` (`TimelineArea`), with `<Bar>` at 455, `<Line>` at 475 and `<Area>` at 498.

- Add a prop `animate?: boolean` to `TimelineArea`, defaulting to `true` so the Contributors page is unchanged.
- Pass `isAnimationActive={animate}` to every `Bar`, `Line` and `Area`.
- Also turn animation off automatically when `data.length * series.length > 2_000`, whoever the caller is.
- In `HistoryPlot` (`LineOwnershipCharts.tsx:98`), pass `animate={false}`.
- While there, use `type="linear"` instead of `"monotone"` when `data.length > 500`. Monotone interpolation costs more to compute and can't be seen at that density.

### 4.3 [E, part 1] Stop the 5-second full reload during sync

**Where:** `src/pages/LineOwnership.tsx:23-43` and `src/lib/ingest/lineOwnership.ts`.

**Problem:** all three queries put `syncing` in their `queryKey` and use `refetchInterval: syncing ? 5000 : false`. Each tick moves ~20 MB through IPC and makes new object references. That invalidates every `useMemo` below, so the 4 s pipeline reruns continuously.

**Implementation:**

1. Add a tiny event bus, `src/lib/ingest/ownershipEvents.ts`:
   ```ts
   type OwnershipEvent = { repoId: number; kind: "snapshot" | "history" | "accounts" };
   const listeners = new Set<(e: OwnershipEvent) => void>();
   export const onOwnershipChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
   export const emitOwnershipChange = (e: OwnershipEvent) => listeners.forEach((fn) => fn(e));
   ```
2. Emit from `syncOwnershipRepo` after `writeOwnershipSnapshot` (snapshot), after each `writeOwnershipHistory` (history), and from `matchGithubAccounts` when `found.length > 0` (accounts).
3. In `LineOwnership.tsx`:
   - Remove `syncing` from all three `queryKey`s and delete every `refetchInterval`.
   - Subscribe in a `useEffect`. Buffer the events and flush **at most once every 10 s** (history batches arrive often), plus once immediately when an event says a repo finished (`done`). Only invalidate when `repoId` is in the current selection:
     - snapshot → `queryClient.invalidateQueries({ queryKey: ["line-ownership"] })`
     - history → `["line-ownership-history"]`
     - accounts → `["github-accounts"]`
   - When sync ends (`syncing` goes true → false), invalidate all three once.
4. Put `staleTime: Infinity` on these queries. Freshness is now event-driven.

Phase 4 (§7.3) makes this per repository. This version already stops the constant thrash.

### 4.4 [R] Separate identity resolution from the contributor filter

**Where:** `prepareOwnershipHistory` and the `prepared` memo at `LineOwnershipCharts.tsx:138`.

**Problem:** changing contributors reruns the whole join, because the filter (`historyAuthorMatches`) runs *before* rows are collected.

**Implementation:**

1. Split the function in two:
   - `resolveOwnershipHistory(points, accounts): ResolvedHistory`. Does the byRepo/day collection, interning, union-find, labels, and `keyOf(internedId)`. Memoised on `[points, accounts]`.
   - `prepareOwnershipHistory(resolved, selectedLogins): PreparedOwnershipHistory`. Filters and does the daily sums. Memoised on `[resolved, selectedLogins]`.
2. `ResolvedHistory` holds `carried` as `Map<repoId, Array<{ day, authors: Array<{ id: number; lines: number }> }>>`, using interned ids rather than objects. It also holds `selectionTokens: string[][]` per interned id (the lowercased author, names, emails and logins), so filtering is a set lookup per interned id rather than per row.
3. **Semantics decision (see §9, item 1).** Today an author row is kept when *that row's own* names, emails or login match the selection, and rows that fail never take part in merging. The snapshot summary (`aggregateOwnership`) instead resolves people first, then selects a whole person if any alias matches. I recommend switching history to the snapshot's semantics: `selectedPeople = { find(id) | tokens(id) ∩ selected ≠ ∅ }`. Then the history chart and the summary agree. If we want exact parity instead, filter per interned id; either is cheap.
4. Keep `ownershipHistorySeries` as a wrapper that calls both, so existing tests don't change.

**Expected:** changing the contributor filter costs the daily sum only (tens of ms). Phase 4's sweep makes it ~1 ms.

---

## 5. Phase 2: sync quick wins on the existing blame engine

These changes stay on the blame-based walk. They're worth doing before F for three reasons:

- They make sync tolerable within days.
- F keeps a blame path for merge commits and as its test oracle.
- G, C and P carry over directly to F.

### 5.1 [G] Take the fixed per-commit work out of the loop

**Where:** `scan_snapshot_at` (`line_ownership.rs:662`) and `advance_history` (`:1124`).

Every history step currently spawns:

- `rev-parse --is-bare-repository`
- `rev-parse --absolute-git-dir`
- `rev-parse --verify <rev>^{commit}`
- `rev-parse --is-shallow-repository`
- `merge-base --is-ancestor`
- `rev-parse <sha>^` (adjacent path)
- `diff-tree`
- `ls-tree -r` of the **whole tree**
- `cat-file --batch`
- one `blame` per changed file
- `log --no-walk` for co-author bodies

That's about 110 ms of spawns before any blame runs. Each *batch* also re-runs `first_parent_commits` over the entire remaining range, plus `rev-list --count` and `history_aliases` (a full `git log` of the branch). On a 10k-commit repo, that's ~2M commit records re-read across batches.

**Implementation:**

1. **Introduce `WalkContext`**, built once per (repo, target):
   ```rust
   struct WalkContext {
       repo: PathBuf,                 // resolved git dir (bare) or toplevel
       target: String,
       commits: Vec<WalkCommit>,      // whole first-parent plan, oldest first
       total: usize,
       aliases: Vec<Identity>,        // history_aliases(target), once
       person_of: IdentityGroups,     // union-find over aliases, reused by aggregate()
       bodies: HashMap<String, Vec<Identity>>, // co-authors, preloaded
   }
   struct WalkCommit { sha: String, parents: Vec<String>, committed: i64 /* %ct */ }
   ```
   - The plan comes from one `git log --first-parent --reverse --format=%H%x1f%P%x1f%ct <target>`. Knowing each commit's parent removes `rev-parse sha^` and `merge-base`: first-parent ancestry holds by construction.
   - Check bare/toplevel/shallow **once**.
   - Preload co-author bodies for every first-parent commit with one `git log --first-parent --format=%H%x00%B%x00 <target>`. Fable measured 85 ms for the largest repo. Fetch bodies for non-first-parent commits (lines that arrived through merges) lazily in chunks of 200, as today.
   - Cache the context in `ScanControl` under `Mutex<HashMap<(repo, target), Arc<WalkContext>>>` so later batches reuse it. Evict it when the walk reaches `done`, or when a different target arrives for that repo.
2. **Maintain the tree in memory** instead of running `ls-tree -r` at each step.
   - Keep a `BTreeMap<String, TreeEntry { mode, blob, size }>` in the checkpoint.
   - Step it forward with `git diff-tree -r -z --raw --no-commit-id <prev> <sha>`, which gives old and new mode and blob for exactly the changed paths.
   - Take sizes from `cat-file --batch-check` for new blobs only. Sizes only decide job order, so skip them when there are fewer than 8 jobs.
   - Classification (submodule, symlink, generated, binary suffix) runs only on changed entries, and the result is cached in `TreeEntry`.
3. **Stop deep-cloning the file cache.** `cached_files.insert(path.clone(), cached.clone())` (`:859`) clones every untouched file's `counts` map on every commit.
   - Change `Snapshot.files` to `BTreeMap<String, Arc<CachedFile>>`, and turn on serde's `rc` feature in `Cargo.toml`: `serde = { version = "1", features = ["derive", "rc"] }`.
   - Reuse then costs a refcount bump.
4. **Aggregate incrementally.** Today `for file in cached_files.values()` (`:951`) re-sums every file's counts at every commit.
   - Keep `commits: BTreeMap<String, CommitLines>` in the checkpoint.
   - For each recalculated file, subtract the old `CachedFile.counts` and add the new ones. Drop entries that reach 0 lines.
5. **Cache identity groups in `aggregate()`.** The aliases are constant for the walk, so build the union-find over `aliases` once, in `WalkContext.person_of`. Per point, only map each commit's author and co-authors to a group key (a hash lookup), then sum. New identities that aren't in the aliases are rare and get their own singleton.
6. Carry `history_aliases`, `rev-list --count` and the plan via `WalkContext`. Delete the per-batch calls at `:1199` and `:1210`.

**Tests:** all existing `history_*` and `incremental_*` tests must pass unchanged. Add a test that a two-batch walk makes the same points as one large batch.

**Expected:** ~180 ms/commit → ~40–70 ms/commit (bounded by blame).

### 5.2 [D] Calculate only daily endpoints

**Where:** `advance_history`. `first_parent_commits` feeds `WalkContext.commits` after G.

The chart keeps only the last point per repo per UTC day (`ownershipHistory`'s `ROW_NUMBER`, `db/lineOwnership.ts:174`), so ~69% of the calculated snapshots are thrown away.

**Implementation:**

1. **Choose endpoints** once, in `WalkContext`:
   ```rust
   // Walk order is authoritative; committer dates can go backwards on rebased
   // branches, so clamp to keep days monotone.
   let mut day_prev = i64::MIN;
   for (i, c) in commits.iter().enumerate() {
       let day = max(c.committed.div_euclid(86_400), day_prev);
       c.day = day; day_prev = day;
   }
   endpoints = indices where i == last || commits[i + 1].day != commits[i].day
   ```
2. **Step between endpoints with the existing non-adjacent path.**
   - When the previous endpoint isn't the direct parent, call `scan_snapshot_at` with `adjacent = false`. It already collects every path touched in `prev..sha` using `log --name-only --full-history -m`, so change-then-revert inside a day stays correct (Astra's caveat).
   - With G's in-memory tree, use `diff-tree` for the tree delta, and union it with the `log --name-only` path list for the blame set.
3. `batch_limit` now counts endpoints rather than commits. Progress still reports commits: `completed = index of endpoint in commits`.
4. Emit the point with `committed_at` = the endpoint's timestamp. Existing rows stay compatible because the query still picks one row per day.
5. **Optional coarser resolution for old history** (Opus Medium's "weekly for older history"). Add `const HISTORY_RESOLUTION: Resolution = Resolution::Daily;` with a `WeeklyBefore(days)` variant, but ship daily: the Day view exists and F makes the saving moot. Keep the enum so the choice stays explicit.

**Tests:**
- A fixture with 3 commits on the same day, where the middle one changes a file and the last reverts it. The day's point must equal a full scan at the last commit.
- A fixture with an out-of-order committer date. Days stay monotone.
- A resume that lands mid-day.

**Expected:** 3.2× fewer snapshot calculations org-wide (10× on orchestra). It multiplies with G only roughly: the non-adjacent `log` range adds a spawn per endpoint.

### 5.3 [C] Keep the history checkpoint in Rust, not the WebView

**Where:** `advance_line_ownership_history` (`:1478`), `syncOwnershipRepo`, and `db/lineOwnership.ts`: `ownershipHistoryCache`, `writeOwnershipHistory`, and `line_ownership_history_state.cache`.

**Problem:** every batch moves the whole file cache (up to 3.7 MB of JSON) SQLite → WebView → Rust → WebView → SQLite, and serialises and parses it at every hop.

**Implementation:**

1. **Store checkpoints on disk** under `app_cache_dir/line-ownership/<owner>/<name>.history/`:
   - `ckpt-<sha>.bin`: the walk state at that cursor, written atomically (write `*.tmp`, `fsync`, `rename`).
   - Keep the **two** newest checkpoints. JS persists the cursor only after Rust returns, so a crash between the two leaves SQLite pointing at the previous checkpoint, which still exists.
   - Use a compact encoding. Add `postcard` (serde-compatible, no schema) or `bincode` to `Cargo.toml`; JSON for large `Vec`/`BTreeMap` state is several times bigger and slower.
2. **Keep the live state in memory:** `ScanControl.walks: Mutex<HashMap<String /*repo*/, WalkState>>`. Consecutive batches in one sync never reload from disk. Evict on done, cancel or error.
3. **New command signature:**
   ```rust
   advance_line_ownership_history(github_repo, job_id, revision, cursor: Option<String>, legacy_cache: Option<String>, on_progress)
     -> HistoryBatch { points, cursor: Option<String>, reset, done, completed, total }
   ```
   - The `checkpoint: String` field goes away.
   - Rust loads the in-memory state, then `ckpt-<cursor>`. If neither exists (or the version or options differ), it resets the walk, as it does today.
   - `legacy_cache` is a one-release compatibility path. When JS still has an old `cache` column value and Rust has no checkpoint file, JS passes it once, Rust saves it as `ckpt-<cursor>`, and JS then clears the column.
4. **JS side** (`ingest/lineOwnership.ts`):
   - The loop passes `cursor` (from `line_ownership_history_state.revision`) instead of `previousJson`.
   - `writeOwnershipHistory` writes points and the cursor only. `cache` becomes `''` (dropped in Phase 4's schema bump).
   - Delete `ownershipHistoryCache`.
5. **Bigger, time-boxed batches.** With the checkpoint off the IPC path, change the fixed `25` (`:1512`) to "stop after **5 s** or 500 endpoints, whichever comes first". That keeps cancellation and progress responsive and removes most per-batch overhead.
6. **Move the HEAD file cache out of `line_ownership.snapshot` the same way** (Opus High):
   - Rust stores the HEAD `Snapshot` (files + co-authors) in `…/<name>.head.bin`.
   - SQLite keeps `report TEXT`, `version INTEGER` and `options TEXT` as real columns (added in the Phase 4 schema bump, or here with an `ALTER TABLE`).
   - `ownershipSnapshots` then selects `report` directly instead of running `json_extract` over multi-MB rows.
   - `METADATA`, `touchOwnershipSnapshot` and `writeOwnershipSnapshot` compare columns instead of JSON paths.
   - `sync_line_ownership` loads the previous snapshot from disk rather than taking `previous_json`.
   - If the file is missing, Rust does a full scan (or, after F, builds from the walk state).

**Tests:**
- A Rust test for checkpoint round-trips: resuming from the disk file makes identical points.
- A missing file forces a reset.
- A corrupt file forces a reset, not an error.
- In `test-line-ownership.mjs`, update the `__invoke` fixture to check that no multi-MB strings cross `invoke`. Assert that argument sizes stay under 64 KB.

### 5.4 [P] Calculate several repositories at once

**Where:** `ScanControl.calculation: Arc<Mutex<()>>` (`:21`, used at `:1418` and `:1497`), `worker_count()` (`:313`), and `sync.ts:752` (`pool(ownershipTargets, 2, …)`).

**Implementation:**

1. **Replace the mutex with a counting semaphore.** `std` has none; ~30 lines with `Mutex<usize>` + `Condvar`:
   ```rust
   struct Permits { free: Mutex<usize>, cv: Condvar }
   impl Permits {
       fn acquire(&self, cancelled: &AtomicBool) -> Result<PermitGuard<'_>, String> {
           let mut free = self.free.lock().unwrap_or_else(|p| p.into_inner());
           loop {
               check_cancel(cancelled)?;
               if *free > 0 { *free -= 1; return Ok(PermitGuard(self)); }
               free = self.cv.wait_timeout(free, Duration::from_millis(50)).unwrap().0;
           }
       }
   }
   // PermitGuard::drop increments and notify_one()
   ```
   - Permits: `(available_parallelism / 4).clamp(1, 4)`. That's 3 on 14 cores.
2. **Split the blame workers across permits:** `worker_count() = (available_parallelism / permits).clamp(1, 4)`. That caps concurrent `git blame` processes near the core count.
3. Add a command `line_ownership_concurrency() -> usize` that returns the permit count. JS calls `pool(ownershipTargets, permits + 1, …)` so downloading and preparing one repo overlaps with calculating the others. Update the comment at `sync.ts:749`.
4. **Fan out blame jobs across endpoints within a batch** (Fable's "global queue", scoped to one repo). Blame at a revision doesn't depend on other endpoints. Only the *which paths changed* step is sequential, and it's cheap.
   - For a batch, first run through the endpoints computing each one's `(endpoint, path, blob)` jobs from the tree deltas.
   - Push all of them into one job list for the existing worker pool, then aggregate the endpoints in order.
   - This turns 1–3 blames per step into dozens in flight.
   - Cap in-flight results with the existing `sync_channel`.
5. SQLite writes stay serialised through `withWriteLock`. The only shared resource under contention is CPU.

**Tests:** run two repos at once in a Rust test; both must match their serial results. Cancelling one job must not cancel the other (this already has a test at `:2055`; extend it).

**Expected:** near-linear gains up to the permit count on the remaining time. With F, each repo is one streaming `git log` plus one parsing thread, so running repos in parallel is the main lever left.

---

## 6. Phase 3 [F]: forward diff replay instead of repeated blame

This is the change that moves sync from hours to minutes. It replaces "blame every changed file at every commit" with one streaming pass over the first-parent history that tracks who owns every line.

### 6.1 Design

New module: `src-tauri/src/line_ownership/replay.rs`.

```rust
/// Interned per walk; indices are stable for the life of a checkpoint.
struct CommitInfo {
    sha: String,
    author: u32,          // identity id
    people: Box<[u32]>,   // distinct person-group ids for author + co-authors (after alias grouping)
}
struct FileState {
    owners: Vec<u32>,     // commit index per line, in file order
    blob: String,
    kind: FileKind,       // Text | Binary | Excluded(reason)
}
struct WalkState {
    version: u32,
    options: ScanOptions,
    cursor: String,                   // last applied first-parent commit
    cursor_day: i64,
    mailmap_blob: Option<String>,     // HEAD:.mailmap when state was built
    identities: Interner<Identity>,
    groups: Vec<u32>,                 // identity id -> person-group id
    commits: Vec<CommitInfo>,
    commit_index: HashMap<String, u32>,
    files: HashMap<String, FileState>,
    lines_by_commit: Vec<u64>,
    person_lines: Vec<i64>,           // person-group id -> credited lines (current)
    emitted_person_lines: Vec<i64>,   // as of the last emitted day
    total_lines: u64,
    coauthored_lines: u64,
}
```

### 6.2 The stream

A single process per batch, from `cursor` (or the root) to `target`:

```
git -c core.quotePath=false log --first-parent --reverse
    --diff-merges=first-parent --no-color --no-ext-diff --no-textconv
    --full-index -p -U0 -w -M --diff-algorithm=myers
    --format=%x00C%x00%H%x00%P%x00%ct%x00%aN%x00%aE%x00
    <cursor>..<target> --
```

- `-U0 -w` gives hunks without whitespace-only changes, so those lines keep their owner. That matches `blame -w`, which `managed_options` uses (`ignore_whitespace: true`).
- `-M` follows whole-file renames, as blame does by default. **Don't** pass `-C`, because blame here doesn't detect copies.
- `--diff-algorithm=myers` must match blame's diff. Pin every diff option that affects hunk placement (algorithm, indent heuristic) explicitly on **both** the replay stream and the fallback blame command, so user config can't make them diverge. The equivalence tests in §6.6 are the arbiter.
- `%aN`/`%aE` apply the mailmap. In a bare repo both `log` and `blame` read `HEAD:.mailmap`, so identities agree.
- The root commit's diff is against the empty tree (`log` defaults to `--root`).

**Parser** (a streaming `BufRead` over `process::stream`, the same cancellation and kill semantics as today):

- `\0C\0` record → new commit. Intern the author and look up co-authors (from `WalkContext.bodies`, which is preloaded).
- `diff --git a/… b/…`, then the header lines. Handle each:
  - `rename from`/`rename to` → move the `FileState`.
  - `new file mode`/`deleted file mode`/`old mode`/`new mode` → mode `120000` is a symlink and `160000` a submodule, both excluded.
  - `index <old>..<new> <mode>` → the new blob.
  - `Binary files … differ` → `FileKind::Binary`: drop the owners and count it under skipped `binary`. Git's diff binary check and `binary_blobs` both look for a NUL in the first 8,000 bytes. A `.gitattributes` `-diff`/`binary` attribute could still make them disagree, so when this line appears on a path that isn't a binary suffix, confirm with `cat-file` (one batched call per commit, rare).
- Apply the exclusion patterns (`GENERATED` + `options.excludes`) and `BINARY` suffixes by path, as `scan_snapshot_at` does. Excluded files are tracked for the skipped counts but have no owners.
- `@@ -a,b +c,d @@` hunks: with `-U0`, apply them in order with a running offset:
  ```rust
  let start = (a as isize - 1 + if b == 0 { 1 } else { 0 } + offset) as usize;
  for &owner in &owners[start..start + b] { lines_by_commit[owner] -= 1; dirty.insert(owner); }
  owners.splice(start..start + b, std::iter::repeat(current).take(d));
  lines_by_commit[current] += d; dirty.insert(current);
  offset += d as isize - b as isize;
  ```
  Skip the `+`/`-` content lines after reading the header (the counts are enough), and ignore `\ No newline at end of file`.

### 6.3 Merge commits: exact attribution through a blame fallback

A first-parent diff of a merge credits the merger with lines that were written on the side branch. Merges are rare on first-parent here (6 of 1,410 in fd-symphony), but they must match blame.

For a commit with more than one parent:

1. Parse the diff as usual to get the **set of touched paths**, but don't apply the hunks.
2. For each touched text path, run `git blame --incremental -w <sha> -- <path>` (through the worker pool, in parallel), then **rebuild `owners` exactly**. The incremental output gives `<sha> <orig> <final> <count>` groups plus `author`/`author-mail`, so `owners[final-1 .. final-1+count] = commit_index(sha)`.
3. Commits that blame reports but the walk hasn't seen (side-branch commits) are added to `commits` from blame's author fields. Their co-author bodies are fetched in a batch.
4. Adjust `lines_by_commit` by diffing the old and new `owners`.

The same fallback covers **legacy or partial checkpoints**: when a file first appears without a `FileState` (e.g. resuming from a pre-F checkpoint), blame it once at the current commit.

### 6.4 Person totals, deltas and daily emission

- **Grouping:** at walk start, build the union-find over `WalkContext.aliases` + known identities, using the same rules as `aggregate()` (identity key, normalised name, GitHub login, GitHub id). `groups[identity] = person-group id`. `CommitInfo.people` is the deduped set of group ids for author + co-authors, so co-authored lines by the same person are credited once, as today.
- **Incremental totals:** after each commit, for every `dirty` commit `c` with line delta `Δ`, add `Δ` to `person_lines[g]` for each `g` in `c.people`. Update `total_lines` (when `people` is non-empty) and `coauthored_lines` (when `people.len() > 1`).
- **Daily emission:** use D's clamped UTC day. When the next commit's day differs, or at the end of the stream, emit a day record:
  ```rust
  struct DayDelta { day: i64, person: u32, delta: i64 }
  ```
  - Emit one `DayDelta` per group where `person_lines[g] != emitted_person_lines[g]`, then copy `person_lines` into `emitted_person_lines` for those groups.
  - Also emit `total_lines`/`coauthored_lines` for the day.
- **People table:** for every group that has ever had lines, emit `{ person, label, names, emails }`. Use `aggregate()`'s ranking rules so names and emails are ordered by lines, and the label is login > spaced name > first name.
- **Alias changes on a later sync:** when a new target's aliases would **merge two existing groups**, past deltas were credited under the separate groups. Mixing them would drift, because a co-authored line would be decremented once but was incremented twice. Detect this at walk start by recomputing `groups` for known identities and comparing. If any change, **reset this repo's history**, which takes seconds with F. See §9, item 2.
- **Mailmap changes:** if `HEAD:.mailmap`'s blob differs from `WalkState.mailmap_blob`, reset (identities for every old commit change). This matches today's behaviour of rebuilding on mailmap changes.

### 6.5 Batching, checkpoints, HEAD report

- Batches are time-boxed as in §5.3: restart `git log <cursor>..<target>` per batch (one spawn every few seconds, negligible), with the state held in memory and checkpointed to `ckpt-<sha>.bin`.
- `HistoryBatch.points` becomes `days: Vec<DayRecord>` plus `people: Vec<PersonRow>` (only new or changed people). Phase 4 persists them. Until Phase 4 lands, a small adapter turns day records into today's `HistoryPoint { authors }` shape, so F can ship first. See §7.
- **HEAD report from the walk:** once the cursor reaches the target, `WalkState` has everything `Report` needs:
  - `credits` = `commits` with `lines_by_commit > 0` and their people
  - `authors` from `aggregate()`
  - `files_blamed` = the number of `Text` files
  - `files_skipped` from `FileKind`
  - Add `line_ownership_report_from_history(github_repo, revision) -> String` and call it in `syncOwnershipRepo` instead of `sync_line_ownership` when the history cursor equals `prepared.revision`. Keep `sync_line_ownership` (the blame scan) as a fallback and as the test oracle.
  - This reorders `syncOwnershipRepo`: history first, then the report. That removes the separate full-tree blame on first sync.
- **Engine switch:** `enum HistoryEngine { Blame, Replay }`, chosen by `GITHUB_MONITOR_OWNERSHIP_ENGINE` (dev) or a hidden setting. Default to `Replay` once §6.6 passes, and keep `Blame` for one release to compare against.
- Bump `SNAPSHOT_VERSION` to 3. Old checkpoints are then ignored, apart from the per-file blame bootstrap in §6.3.

### 6.6 Tests (the gate for defaulting to replay)

Add these to the `mod tests` in `line_ownership.rs`:

1. **Equivalence at every commit.** For every existing fixture (`history_*`, `incremental_*`, `surviving_lines_*`, `whitespace_*`, `transitive_identity_*`, `a_sign_off_*`, …), walk with replay and compare person totals at every first-parent commit against `scan_snapshot_at(…, pinned=sha)` with a full blame. Reuse `assert_same_people`/`assert_matches_full`.
2. Targeted fixtures:
   - whitespace-only edit
   - rename, then rename + edit in one commit
   - delete, then restore (the restorer gets credit: `history_credits_a_restored_line_to_the_restoring_commit`)
   - merge whose side branch adds lines (side authors get credit)
   - file toggling text → binary → text
   - file becoming a symlink
   - a submodule
   - a generated-pattern path
   - `.mailmap` change → reset
   - co-author trailers, including the same person as author and co-author
   - CRLF lines
   - no trailing newline
   - an empty file
   - a non-UTF-8 path (same error as today)
   - a 10k-line hunk
3. **Real-repo equivalence (ignored test):** on each cached clone, the replay's HEAD `Report` must equal `sync_line_ownership`'s blame `Report`, field by field.
4. **Resume equivalence:** a walk split at random cursors, including mid-day, equals a single walk.
5. **Bench:** `bench_history_walk` with `ENGINE=replay`. The Grok transcript reports ~2 ms/commit on orchestra after the opening batch.

---

## 7. Phase 4: compact storage and incremental loading

### 7.1 [S] Store daily per-person deltas and people separately

Replace `line_ownership_history` (every point stores every author's names and emails: 58 MB for 25k rows, ~200 distinct people) with:

```sql
-- Stable per-repository people. The UI joins these across repositories.
CREATE TABLE IF NOT EXISTS line_ownership_people (
  repo_id INTEGER NOT NULL,
  person_id INTEGER NOT NULL,       -- WalkState person-group id
  label TEXT NOT NULL,
  names_json TEXT NOT NULL,         -- ranked, as aggregate() orders them
  emails_json TEXT NOT NULL,
  PRIMARY KEY (repo_id, person_id)
) WITHOUT ROWID;

-- Only non-zero changes. A level on any day is the prefix sum up to that day.
CREATE TABLE IF NOT EXISTS line_ownership_daily (
  repo_id INTEGER NOT NULL,
  day INTEGER NOT NULL,             -- unix seconds at UTC midnight (clamped, monotone)
  person_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  PRIMARY KEY (repo_id, day, person_id)
) WITHOUT ROWID;

-- Per-day repository totals, for the Total split and the coauthored figure.
CREATE TABLE IF NOT EXISTS line_ownership_daily_totals (
  repo_id INTEGER NOT NULL,
  day INTEGER NOT NULL,
  total_lines INTEGER NOT NULL,
  coauthored_lines INTEGER NOT NULL,
  PRIMARY KEY (repo_id, day)
) WITHOUT ROWID;
```

`line_ownership_history_state` keeps `(repo_id, revision, target)` and drops `cache`.

**Writes** (`writeOwnershipHistory` → `writeOwnershipDays`):
- In one `withWriteLock` transaction, `bulkInsert` the people (upsert), the daily rows and the totals, then move the cursor.
- A batch can end mid-day (the time box can land anywhere). Rust emits whatever changed since the last emission, so the next batch may emit more deltas for the same day. Upsert with `ON CONFLICT (repo_id, day, person_id) DO UPDATE SET delta = delta + excluded.delta` (and replace for `daily_totals`) so partial days add up.
- On `reset`, delete that repo's rows from all three tables.

**Reads**, one query per repo (see K), with the rows packed into a single JSON string to avoid per-row IPC objects:
```sql
SELECT json_group_array(json_array(day, person_id, delta)) AS rows
FROM (SELECT day, person_id, delta FROM line_ownership_daily WHERE repo_id = $1 ORDER BY day, person_id);
```
Expect ~25k small tuples org-wide today, compared with 16 MB now.

**Migration** (`SCHEMA_VERSION` 7 → 8). `getDb` has no migration step today, so add one:
- Read `meta.schema_version` before running `SCHEMA_SQL`.
- If it's below 8: create the new tables, `DROP TABLE line_ownership_history`, and `DELETE FROM line_ownership_history_state`, so history rebuilds on the next sync.
- If §5.3 didn't already add them, add the `report`, `version` and `options` columns to `line_ownership` and backfill `report` with `json_extract(snapshot, '$.report')`.
- Rebuilding is acceptable **only because F has landed** (minutes, not hours). That's why S comes after F.
- Tell the user the history will rebuild: a one-line callout on the Line Ownership page when the history state is empty but snapshots exist.

### 7.2 [T] Build the chart with an event sweep

Replace the dense `days × repos × authors` carry in `prepareOwnershipHistory` with a sweep over deltas. Everything is linear in the number of change events plus the number of plotted buckets.

New file: `src/lib/ownershipHistory.ts`. Keep `lineOwnership.ts` for snapshots.

```ts
interface RepoHistory { repoId: number; people: PersonRow[]; deltas: Int32Array /* [day, person, delta]* */; totals: … }

/** Once per (repos, accounts): join people across repositories. ~ repos × people rows, so ~4k at most. */
resolvePeople(histories, accounts): { globalOf: Map<repoPersonKey, number>; labels: string[]; tokens: string[][] }

/** Once per filter: which (repo, person) pairs count. */
selectPeople(resolved, selectedLogins): Uint8Array /* per global person */

/** Per control change: one merge-sweep over every repository's sorted deltas. */
sweep(histories, resolved, selected, { split, bucketOf, reading }): { rows, series }
```

**Sweep:**
- K-way merge by day over each repo's already-sorted deltas, or concatenate and sort once when resolving.
- Keep `level[global]` (people split) or `level[repoId]` (repository/total split).
- At each bucket boundary (`bucketOf(day)` changes), snapshot the levels into a row.
- **Cumulative** = the levels at the end of the bucket. **Per period** = the levels minus the previous bucket's levels, which is what `ownershipHistoryBuckets` does now, with the first change measured from zero.
- **Series ranking by peak:** `rankHistorySeries` ranks by each series' maximum *daily* level. Track `peak[key] = max(peak, level)` at every event day during the sweep (not only at bucket ends), so the ranking stays the same when the period changes.
- The `limit` and "Other" folding work as today.
- **Day buckets with the Day period:** emit a row for every calendar day between min and max. Days without events repeat the previous levels, as today's carry-forward does. L then bounds how many rows are drawn.
- The **selection** filter uses the per-person flag from `selectPeople`, with the semantics from §4.4.

**Parity test:** in `test-line-ownership.mjs`, convert the existing `OwnershipHistoryPoint[]` fixtures into deltas with a helper. Assert that `sweep(...)` equals the old `ownershipHistoryBuckets(projectOwnershipHistory(prepareOwnershipHistory(...)))` for every split, limit, period and reading. Keep the old functions **in the test file only**, as the oracle, once the page switches over.

### 7.3 [K + E, part 2] Load history per repository and refresh only what changed

**Where:** `src/pages/LineOwnership.tsx`.

1. **A revision probe:** one cheap query per page, `SELECT repo_id, revision FROM line_ownership_history_state WHERE repo_id IN (…)`, plus `SELECT repo_id, calculated_at FROM line_ownership WHERE repo_id IN (…)`. Key it on `["line-ownership-revisions", repoIds]` and invalidate it from the §4.3 event bus.
2. **Per-repo data queries** with `useQueries`:
   ```ts
   useQueries({ queries: repoIds.map((id) => ({
     queryKey: ["line-ownership-days", id, revisions.get(id) ?? null],
     queryFn: () => ownershipDays(db, id),
     staleTime: Infinity, gcTime: 30 * 60_000,
   })), combine: (results) => results })
   ```
   Do the same for snapshots: `["line-ownership-report", id, calculatedAt]` → `ownershipReport(db, id)`.
   - Adding or removing one repo now fetches **only** that repo. Everything else comes from the cache.
   - A repo that finishes syncing changes its revision in the probe, so only its key changes.
3. **Stable combination.** Memoise the combined array on the *list of per-repo `dataUpdatedAt`*, so unchanged repos keep referential identity. `resolvePeople` can then cache per-repo work in a `WeakMap<RepoHistory, …>`.
4. Drop `placeholderData: keepPreviousData` from the per-repo queries (a repo with no data yet just doesn't contribute). Keep an overall "still loading N repos" indicator.
5. **Accounts:** `["github-accounts"]` with `staleTime: Infinity`, invalidated only by `accounts` events.
6. **The event bus from §4.3 becomes per repo.** Instead of broad invalidation, a `history` or `snapshot` event for repo X invalidates only `["line-ownership-revisions"]`, and the revision change moves X's key. Keep the 10 s throttle for mid-walk batches, and refresh immediately on `done`.

---

## 8. Phase 5: rendering

After Phases 1 and 4, data preparation takes a few ms. What's left is drawing.

### 8.1 [L] Plot only as many points as the chart has pixels

**Where:** `OwnershipHistoryChart` and `HistoryPlot` in `LineOwnershipCharts.tsx`.

1. Measure the plot width with a `ResizeObserver` on the chart container. Set `budget = clamp(floor(width / 2), 150, 800)` points.
2. **Pick an effective bucket.** If the chosen period over the visible range gives more rows than `budget`, coarsen to k-day buckets, with `k = ceil(rows / budget)` rounded up to 2, 3, 7, 14, 30 or 91. Feed that as `bucketOf` into the §7.2 sweep:
   - **Cumulative** reading: a stock, so sampling at the period end is exact for the plotted points.
   - **Per period** reading: the difference of period-end levels equals the sum of the daily changes in the bucket. Totals are preserved and nothing is double counted.
   - Show it in the caption: "Plotted at 7-day resolution to fit the chart; zoom with the brush for daily points."
3. **Zoom restores detail:** the brush selects a range over the full timeline. The visible range is re-swept at its own budget, so zooming in shows daily points.
4. **The table and exports keep the chosen period at full resolution.** Only the plotted series is coarsened. Tooltips read the plotted row, and their heading shows the bucket's date range.
5. **Cap interactive series:** with "All", draw at most **40** named series and fold the rest into "Other". The legend note explains this ("40 largest shown; the table lists everyone"). See §9, item 6.
6. **Bars at day granularity:** the budget applies, so Bars never draws ~27k rects again.

### 8.2 [V] A purpose-built SVG renderer for ownership history

Recharts builds a React element per point, per series, plus the brush. Even at ~800 points × 9 series, re-rendering costs tens of ms, and "All" is worse. Replace it **for this chart only** (Contributors keeps `TimelineArea`).

New component: `src/components/OwnershipTimeline.tsx`.

- **Props:** `{ rows, series, shape, stackMode, values, activeKeys, onToggleKey, labelOf, valueLabel, height, brush: { range, onChange, overview } }`.
- **Geometry** (memoised on `[rows, series, shape, stackMode, values, width]`):
  - The x scale maps index → px (uniform spacing, because rows are buckets).
  - The y scale uses a nice-number max. Reuse the tick helpers in `charts.tsx`, or add a 10-line `niceTicks`.
  - **Share** mode reuses `toShares` from `charts.tsx`; export it.
  - **Stacked area:** keep a running baseline array and emit **one `<path>` per series**: the upper edge left→right, then the lower edge right→left, joined with `L`.
  - **Line:** one `<path>` of `M/L` commands per series.
  - **Bars:** one `<path>` per series, made of `M x y h w v hgt h -w Z` rect commands. Use the existing `barGeometry` for width and gap.
  - Path strings are built with plain string concatenation over typed arrays, which is ~1 ms for 9 × 800 points.
- **Axes and grid:** a handful of `<line>`/`<text>` elements, formatted with `weekTickFormatter`, `compact` and `share` from `charts.tsx`, and styled with the `useVizPalette` tokens so it looks like the rest of the app.
- **Tooltip:** one transparent `<rect>` overlay. `pointermove` → `index = round((x - left) / step)` → draw a crosshair `<line>` and render the existing `TooltipShell` with the same content logic as `TimelineArea` (top 10, "and N more", share formatting). Throttle with `requestAnimationFrame`.
- **Dimming:** a per-path `opacity` from `activeKeys`, with no re-geometry.
- **Brush:** a 28px SVG under the plot showing the total outline (one path), plus a draggable window with two handles. Pointer capture drives `onChange({ start, end })` (Grok's transcript has a working version). The visible range feeds §8.1.
- **Legend:** reuse `ClickableLegend`.
- **Accessibility:** `role="img"` plus an `aria-label` summary. The data table stays the accessible alternative.
- **Test:** a small Node test of the geometry builder. Stacked upper edges must equal the cumulative sums, and share mode must sum to 1.
- **Fallback:** if the custom renderer turns out to cost more than planned, `uPlot` (canvas, ~45 KB, from jsdelivr/npm) handles 100k+ points in ms. Keep the geometry and tooltip API so uPlot could slot in behind it. I recommend the custom SVG first because it matches the app's chart styling exactly (§9, item 5).

### 8.3 [W] Move the remaining history work to a Web Worker

After S, T, K and L, the per-change work is small, but it still scales with repos × events. A worker guarantees the controls never freeze, which `useDeferredValue` can't do: it can't interrupt a synchronous `useMemo`.

1. `src/workers/ownershipHistory.worker.ts`, created with Vite's `new Worker(new URL("../workers/ownershipHistory.worker.ts", import.meta.url), { type: "module" })`.
2. **Protocol** (tiny, typed, no library):
   ```ts
   type In =
     | { type: "load"; repoId: number; revision: string; people: PersonRow[]; deltas: Int32Array; totals: Int32Array } // deltas/totals transferred
     | { type: "unload"; repoId: number }
     | { type: "accounts"; entries: [string, GithubAccount][] }
     | { type: "compute"; id: number; repoIds: number[]; selected: string[]; split; limit; period; reading; budget; range };
   type Out = { type: "result"; id: number; rows: Array<Record<string, number>>; series; effectiveBucket; tableRows? };
   ```
   - The worker keeps per-repo histories and the resolved people cache, so a `compute` sends only options.
   - The main thread keeps a `latestId`. Results with an older `id` are dropped, so fast clicking never shows stale frames.
   - Send `tableRows` only when the table view is open.
3. `useOwnershipHistoryWorker()` hook: it loads or unloads repos as the §7.3 queries resolve, posts `compute` on every option change, and returns `{ rows, series, pending }`. `pending` drives the existing `loading` spinner on `ChartCard`.
4. **Test harness:** the sweep functions are pure. `test-line-ownership.mjs` tests them directly, and the worker is a thin wrapper.
5. **Optional:** move the snapshot `aggregateOwnership` (currently < 60 ms) into the same worker if Phase 0 shows it above ~30 ms with all 216 repos.

---

## 9. Decisions to make before implementation

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| 1 | History contributor filter: per author row (today) or per resolved person (like the snapshot summary) | **Per person** | The history chart and the summary then agree, and a selected login includes all of that person's aliases |
| 2 | When a new sync's aliases merge two existing person groups | **Reset that repo's history** (seconds with F) | Keeping old deltas under split groups drifts co-authored counts |
| 3 | Committer dates that go backwards along first-parent | **Clamp to walk order** (monotone days) | Walk order is the history; the chart can't go back in time |
| 4 | Lines that arrived through merge commits | **Blame fallback for merges** (exact, as today) | Rare (≈0.4% of commits), keeps parity with blame |
| 5 | Renderer for ownership history | **Custom SVG paths**; uPlot as fallback | No dependency, matches the chart design system, and Grok's transcript shows it's viable |
| 6 | Series cap for "All" | **40 named + Other** | 130 series can't be read and dominate render cost |
| 7 | History resolution | **Daily** (keep the weekly enum unused) | The Day view exists, and F makes the saving moot |
| 8 | Checkpoint encoding | **`postcard`** (serde, compact) | Faster and far smaller than JSON for `Vec<u32>` line owners |

---

## 10. Verification and rollout

- **Every UI PR** must pass `npm run check`, the Phase 0 equality mode (byte-identical until the §4.4 semantics change, and then the updated baseline), and a before/after table in the PR description from `bench:line-ownership`.
- **Every Rust PR** must pass `cargo test` and the ignored real-repo equivalence tests on the three benchmark clones, with a `bench_history_walk` before/after in the PR description.
- **Manual in-app check** for each phase (none of the reviews clicked through the desktop app):
  1. With a sync running, the page stays responsive and the chart updates when a repo finishes.
  2. Change repos, contributors, period, reading, shape and split, and check the Safari timeline for long tasks > 50 ms.
  3. Brush zoom shows daily detail.
  4. Export CSV/JSON matches the table.
- **Rollout:**
  - Ship F behind the engine switch, and run both engines on the full org once, diffing the resulting daily series.
  - Then default to Replay.
  - Remove the blame history walk after one release, but keep `scan_snapshot_at` as the fallback and the test oracle.
- **Risks:**
  - Diff and blame divergence on unusual repos. Mitigation: the equivalence tests, the engine switch, and the per-file blame fallback.
  - Migration wipes history. Mitigation: it only ships after F, with a callout.
  - Concurrency (P) raises peak memory and CPU during sync. Mitigation: the permit count is derived from cores and capped at 4.
