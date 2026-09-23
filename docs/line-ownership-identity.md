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

- **Blame** (default, reference): re-blames each changed text file per commit.
- **Replay** (opt-in in Settings): applies each commit's `-U0 -w` diff. It falls
  back to blame for merges, binary transitions, gitattribute binaries,
  inconsistent hunks, and renames that full `-M` detection might pair differently
  from blame's per-path rename search (any commit with rename pairs). A replayed
  history that fails verification is rebuilt with blame and replay is disabled
  for that repository.

Diff settings are pinned (`diff.algorithm=myers`, indent heuristic) for blame and
replay, so a user's Git config cannot make them disagree.

## Measurements so far

Machine-specific; rerun with `npm run bench:line-ownership -- <copied db>` and the
Rust `history_engine_benchmark`.

- Local data copy (216 repositories, legacy history): history preparation
  3,746 ms → ~21 ms; a contributor change on history 541 ms → ~16 ms; snapshot
  selection 22 ms → 3.5 ms.
- `t3code` (3,768 first-parent commits): blame engine 641 s, 61,544 blame
  processes. Replay results are recorded in the pull request.

Still to measure before changing defaults: packaged-app input-to-paint, full-org
sync wall time and memory with two calculation permits, database size after
rebuild, and replay parity on more real repositories.
