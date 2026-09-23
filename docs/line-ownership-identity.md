# Line ownership: identity, history and storage

This note records what changed when line ownership moved to account-aligned
identity and the incremental history engine, and which differences from the old
output are intentional. The plan is `performance_synthesised_plan.md`.

## Intentional identity changes

A person is a GitHub account whenever GitHub supplies evidence: a commits-API
match for the email, or a numeric-ID noreply address. The account ID is the key,
so a renamed login stays one person, and the label is the login Contributors
shows. Without evidence an author is an **unmatched Git identity**, keyed by
normalized email (or by name within one repository when there is no email).

| Old behaviour | New behaviour |
| --- | --- |
| Two emails sharing a display name were one person | They are separate unless the same account links them |
| Selecting a bare Git name (`Alice`) selected everyone with that name | Only logins and unmatched-identity tokens select; a name selects nobody |
| An email with no match was merged into a namesake's account | It stays unmatched until GitHub matches it or it is mapped in Settings |
| Co-authors who were one person could count twice across aliases | One credit per resolved person per line |
| Unmatched people showed as their Git name | They show as `Unmatched: <name>`; the selector token is `unmatched-email:<email>` |

An ID-less `login@users.noreply.github.com` joins the account whose numeric
noreply address or registry entry names that login, and is otherwise provisional.
Conflicting automatic evidence for one email leaves it unmatched until a manual
mapping is saved with the conflict reviewed.

Manual mappings (Settings → Contributor mappings) apply after automatic evidence:
exact email across all repositories, or an email-less name in one repository.
They regroup attribution; they never change which commit owns a line.

## History storage

- `line_ownership_identity`: raw Git identities per repository generation.
- `line_ownership_day`: one row per UTC day with absolute levels per credit group
  of raw identities. The day's row is chosen by the rule the old query used —
  latest committer second, then the greater SHA — enforced by the upsert, so a
  retried or out-of-order write is idempotent.
- `line_ownership_history_gen`: visible and building generations, cursor and
  native checkpoint reference. A rebuild writes a new generation; one UPDATE makes
  it visible only after its final state matches the HEAD blame scan.
- Legacy `line_ownership_history` rows stay readable until a repository's first
  verified generation replaces them on its next sync.

Each batch writes identities (insert-or-ignore), day rows (winner upsert), then
one UPDATE that advances the cursor and checkpoint. The SQL plugin cannot hold a
transaction across calls, so crash safety comes from that order: anything before
the UPDATE is repeated harmlessly from the previous checkpoint. Revision counters
are bumped by triggers inside the writing statement.

## History engines

The walk visits every first-parent commit and keeps one origin commit per
surviving text line in a native, checksummed checkpoint file.

- **Replay** (default): applies each commit's `-U0 -w` diff. It falls back to
  blame for merges, binary transitions, gitattribute binaries, inconsistent hunks,
  and renames that full `-M` detection might pair differently from blame's
  per-path rename search (any commit with rename pairs). A merge lists every file
  whose bytes differ from the first parent, because `-w` hides whitespace-only
  changes and blame hands a file wholly to any parent it is identical to. A
  replayed history that fails verification is rebuilt with blame and replay is
  disabled for that repository.
- **Blame** (reference, selectable in Settings): re-blames each changed text file
  per commit.

A faster replay that trusted full `-M` rename pairing was tried and rejected: it
disagreed with blame on three of six active Focaldata repositories. It remains
only as a benchmark toggle (`OWNERSHIP_BENCH_FAST=1`).

Diff settings are pinned (`diff.algorithm=myers`, indent heuristic) for blame and
replay, so a user's Git config cannot make them disagree.

## Measurements so far

Machine-specific; rerun with `npm run bench:line-ownership -- <copied db>` and the
Rust `history_engine_benchmark`.

- Local data copy (216 repositories, legacy history): history preparation
  3,746 ms → ~21 ms; a contributor change on history 541 ms → ~16 ms; snapshot
  selection 22 ms → 3.5 ms.
- `t3code` (3,768 first-parent commits): blame engine 641 s with 61,544 blame
  processes; replay 167 s with 22,475 (6,424 for merges, 16,049 for contested
  renames), ending with attribution identical to a full HEAD blame. Replay with
  plain `-M` pairing was faster (61 s) but wrong: it missed a deleted file copied
  to two new paths, which blame credits in both (`replay_follows_renames_the_way_blame_does`).
- Five smaller local repositories (35–165 commits): replay matches HEAD blame.
- Six active Focaldata repositories, replay against a full HEAD blame, all
  matching: fd-participant-experience (481 commits, 2.3 s), fd-core-respondent
  (490, 1.5 s), cin-questionnaire (929, 4.1 s; blame engine 33 s),
  raincloud-playground (903, 54 s), fd-symphony (1,410, 6.9 s), orchestra
  (3,816, 13.7 s). The rejected fast variant failed on cin-questionnaire,
  raincloud-playground and orchestra. cin-questionnaire also exposed the merge
  whitespace case above (`replay_merges_hand_identical_files_to_the_parent_they_match`).

Still to measure: packaged-app input-to-paint, full-org sync wall time and memory
with two calculation permits, and database size after the rebuild. Every
replayed history is verified at the default-branch head in production; that
check cannot see an error confined to earlier days that later disappears, which
is why the fixtures compare every commit.
