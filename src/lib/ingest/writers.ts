import type Database from "@tauri-apps/plugin-sql";
import { bulkInsert, replaceRepoRows, withWriteLock } from "../db";
import { currentWeekStart, dayKey, weeksEndingAt } from "../agg/weeks";
import type {
  GhBranch,
  GhCodeFrequency,
  GhCommitActivity,
  GhCommunityProfile,
  GhContributorStats,
  GhFork,
  GhParticipation,
  GhPunchCard,
  GhRepo,
  GhSbomResponse,
  GhTrafficClones,
  GhTrafficPath,
  GhTrafficReferrer,
  GhTrafficViews,
  GhWorkflowRun,
} from "../github/types";

/**
 * Payload -> rows.
 *
 * Every multi-statement write goes through `withWriteLock` (or
 * `replaceRepoRows`, which uses it). That is not cosmetic: the sync writes
 * several repositories concurrently, and this plugin's connection pool makes
 * real transactions unavailable — see the long note in ../db/index.ts.
 *
 * Weekly rows where every measure is zero are dropped on write; GitHub pads its
 * series with empty weeks and keeping them would multiply row counts for nothing.
 */

export async function writeRepos(db: Database, owner: string, repos: GhRepo[]): Promise<void> {
  await withWriteLock(async () => {
    await bulkInsert(db, {
      table: "repos",
      columns: [
        "id",
        "owner",
        "name",
        "full_name",
        "private",
        "fork",
        "archived",
        "default_branch",
        "language",
        "size_kb",
        "stars",
        "forks",
        "open_issues",
        "can_push",
        "created_at",
        "pushed_at",
        "html_url",
        "description",
      ],
      conflictColumns: ["id"],
      rows: repos.map((r) => [
        r.id,
        owner,
        r.name,
        r.full_name,
        r.private ? 1 : 0,
        r.fork ? 1 : 0,
        r.archived ? 1 : 0,
        r.default_branch ?? null,
        r.language ?? null,
        r.size ?? 0,
        r.stargazers_count ?? 0,
        r.forks_count ?? 0,
        r.open_issues_count ?? 0,
        r.permissions?.push ? 1 : 0,
        r.created_at ?? null,
        r.pushed_at ?? null,
        r.html_url ?? null,
        r.description ?? null,
      ]),
    });

    // Default new repos to selected, without disturbing existing choices.
    await bulkInsert(db, {
      table: "repo_selection",
      columns: ["repo_id", "included"],
      rows: repos.map((r) => [r.id, 1]),
      onConflict: "ignore",
    });
  });
}

export async function writeContributorStats(
  db: Database,
  repoId: number,
  stats: GhContributorStats[],
): Promise<void> {
  const authors = new Map<string, NonNullable<GhContributorStats["author"]>>();
  const rows: unknown[][] = [];

  for (const entry of stats) {
    // GitHub returns a null author for commits whose email maps to no account.
    const login = entry.author?.login ?? null;
    if (!login) continue;
    if (entry.author) authors.set(login, entry.author);

    for (const w of entry.weeks) {
      // Skip GitHub's zero-padding: it inflates row counts with no information.
      if (w.c === 0 && w.a === 0 && w.d === 0) continue;
      rows.push([repoId, login, w.w, w.c, w.a, w.d]);
    }
  }

  await withWriteLock(async () => {
    if (authors.size) {
      await bulkInsert(db, {
        table: "contributors",
        columns: ["login", "gh_id", "avatar_url", "html_url", "type"],
        conflictColumns: ["login"],
        rows: [...authors.values()].map((a) => [
          a.login,
          a.id ?? null,
          a.avatar_url ?? null,
          a.html_url ?? null,
          a.type ?? null,
        ]),
      });
    }

    // Replace rather than merge: GitHub may restate history (rebases, force pushes).
    await db.execute("DELETE FROM contributor_weeks WHERE repo_id = $1", [repoId]);
    await bulkInsert(db, {
      table: "contributor_weeks",
      columns: ["repo_id", "login", "week", "commits", "additions", "deletions"],
      conflictColumns: ["repo_id", "login", "week"],
      rows,
    });
  });
}

export async function writeCommitActivity(
  db: Database,
  repoId: number,
  activity: GhCommitActivity[],
): Promise<void> {
  const rows: unknown[][] = [];
  for (const week of activity) {
    week.days.forEach((commits, dow) => {
      if (commits > 0) rows.push([repoId, week.week, dow, commits]);
    });
  }
  await replaceRepoRows(db, "commit_activity", repoId, {
    columns: ["repo_id", "week", "dow", "commits"],
    conflictColumns: ["repo_id", "week", "dow"],
    rows,
  });
}

/**
 * `stats/participation` returns two bare 52-element arrays with no timestamps —
 * the last element is the current (partial) week. Week keys are reconstructed by
 * counting back from the current week start so this series aligns with the others.
 */
export async function writeParticipation(
  db: Database,
  repoId: number,
  data: GhParticipation,
): Promise<void> {
  const count = data.all?.length ?? 0;
  if (!count) return;
  const weeks = weeksEndingAt(currentWeekStart(), count);
  const rows: unknown[][] = [];
  for (let i = 0; i < count; i++) {
    const all = data.all[i] ?? 0;
    const owner = data.owner?.[i] ?? 0;
    if (all === 0 && owner === 0) continue;
    rows.push([repoId, weeks[i], all, owner]);
  }
  await replaceRepoRows(db, "participation", repoId, {
    columns: ["repo_id", "week", "all_commits", "owner_commits"],
    conflictColumns: ["repo_id", "week"],
    rows,
  });
}

export async function writeCodeFrequency(
  db: Database,
  repoId: number,
  data: GhCodeFrequency[],
): Promise<void> {
  const rows = data
    .filter(([, a, d]) => a !== 0 || d !== 0)
    // GitHub returns deletions negative; stored positive and signed at render time.
    .map(([week, a, d]) => [repoId, week, a, Math.abs(d)]);
  await replaceRepoRows(db, "code_frequency", repoId, {
    columns: ["repo_id", "week", "additions", "deletions"],
    conflictColumns: ["repo_id", "week"],
    rows,
  });
}

export async function writePunchCard(
  db: Database,
  repoId: number,
  data: GhPunchCard[],
): Promise<void> {
  const rows = data
    .filter(([, , c]) => c > 0)
    .map(([dow, hour, commits]) => [repoId, dow, hour, commits]);
  await replaceRepoRows(db, "punchcard", repoId, {
    columns: ["repo_id", "dow", "hour", "commits"],
    conflictColumns: ["repo_id", "dow", "hour"],
    rows,
  });
}

/**
 * Traffic is upserted, never deleted: GitHub only serves a rolling 14 days, so the
 * local table is the only place longer history can exist.
 */
export async function writeTraffic(
  db: Database,
  repoId: number,
  views: GhTrafficViews | null,
  clones: GhTrafficClones | null,
): Promise<void> {
  const rows: unknown[][] = [];
  for (const v of views?.views ?? []) {
    rows.push([repoId, "view", dayKey(new Date(v.timestamp)), v.count, v.uniques]);
  }
  for (const c of clones?.clones ?? []) {
    rows.push([repoId, "clone", dayKey(new Date(c.timestamp)), c.count, c.uniques]);
  }
  await withWriteLock(() =>
    bulkInsert(db, {
      table: "traffic_daily",
      columns: ["repo_id", "kind", "day", "count", "uniques"],
      conflictColumns: ["repo_id", "kind", "day"],
      rows,
    }),
  );
}

export async function writeTrafficBreakdown(
  db: Database,
  repoId: number,
  paths: GhTrafficPath[] | null,
  referrers: GhTrafficReferrer[] | null,
): Promise<void> {
  const today = dayKey(new Date());
  await withWriteLock(async () => {
    if (paths?.length) {
      await bulkInsert(db, {
        table: "traffic_paths",
        columns: ["repo_id", "snapshot_day", "path", "title", "count", "uniques"],
        conflictColumns: ["repo_id", "snapshot_day", "path"],
        rows: paths.map((p) => [repoId, today, p.path, p.title ?? null, p.count, p.uniques]),
      });
    }
    if (referrers?.length) {
      await bulkInsert(db, {
        table: "traffic_referrers",
        columns: ["repo_id", "snapshot_day", "referrer", "count", "uniques"],
        conflictColumns: ["repo_id", "snapshot_day", "referrer"],
        rows: referrers.map((r) => [repoId, today, r.referrer, r.count, r.uniques]),
      });
    }
  });
}

export async function writeCommunity(
  db: Database,
  repoId: number,
  profile: GhCommunityProfile,
): Promise<void> {
  const f = profile.files ?? {};
  const has = (k: string) => (f[k] ? 1 : 0);
  // Single statement: no lock needed.
  await db.execute(
    `INSERT INTO community (repo_id, health, has_readme, has_license, has_coc, has_contrib,
                            has_issue_tpl, has_pr_tpl, has_security, has_desc, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (repo_id) DO UPDATE SET
       health = excluded.health, has_readme = excluded.has_readme,
       has_license = excluded.has_license, has_coc = excluded.has_coc,
       has_contrib = excluded.has_contrib, has_issue_tpl = excluded.has_issue_tpl,
       has_pr_tpl = excluded.has_pr_tpl, has_security = excluded.has_security,
       has_desc = excluded.has_desc, updated_at = excluded.updated_at`,
    [
      repoId,
      profile.health_percentage ?? 0,
      has("readme"),
      has("license"),
      has("code_of_conduct"),
      has("contributing"),
      has("issue_template"),
      has("pull_request_template"),
      f["security"] ? 1 : 0,
      profile.description ? 1 : 0,
      profile.updated_at ?? null,
    ],
  );
}

export async function writeForks(db: Database, repoId: number, forks: GhFork[]): Promise<void> {
  await replaceRepoRows(db, "forks", repoId, {
    columns: [
      "repo_id",
      "fork_id",
      "full_name",
      "owner_login",
      "html_url",
      "created_at",
      "pushed_at",
      "stars",
    ],
    conflictColumns: ["repo_id", "fork_id"],
    rows: forks.map((f) => [
      repoId,
      f.id,
      f.full_name,
      f.owner?.login ?? null,
      f.html_url ?? null,
      f.created_at ?? null,
      f.pushed_at ?? null,
      f.stargazers_count ?? 0,
    ]),
  });
}

export async function writeBranches(
  db: Database,
  repoId: number,
  branches: GhBranch[],
): Promise<void> {
  await replaceRepoRows(db, "branches", repoId, {
    columns: ["repo_id", "name", "protected"],
    conflictColumns: ["repo_id", "name"],
    rows: branches.map((b) => [repoId, b.name, b.protected ? 1 : 0]),
  });
}

/** SPDX package refs look like `pkg:npm/react@19.1.0`; the ecosystem is the purl type. */
export async function writeDependencies(
  db: Database,
  repoId: number,
  payload: GhSbomResponse,
): Promise<void> {
  const seen = new Set<string>();
  const rows: unknown[][] = [];
  for (const pkg of payload.sbom?.packages ?? []) {
    const purl = pkg.externalRefs?.find((r) => r.referenceType === "purl")?.referenceLocator;
    let ecosystem = "unknown";
    let name = pkg.name;
    if (purl?.startsWith("pkg:")) {
      const withoutScheme = purl.slice(4);
      const slash = withoutScheme.indexOf("/");
      if (slash > 0) ecosystem = withoutScheme.slice(0, slash);
    }
    if (!name) continue;
    // SBOM names are sometimes already ecosystem-prefixed, e.g. "npm:react".
    const colon = name.indexOf(":");
    if (ecosystem === "unknown" && colon > 0) {
      ecosystem = name.slice(0, colon);
      name = name.slice(colon + 1);
    }
    const key = `${ecosystem} ${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([repoId, ecosystem, name, pkg.versionInfo ?? null]);
  }
  await replaceRepoRows(db, "dependencies", repoId, {
    columns: ["repo_id", "ecosystem", "package", "version"],
    conflictColumns: ["repo_id", "ecosystem", "package"],
    rows,
  });
}

export async function writeWorkflowRuns(
  db: Database,
  repoId: number,
  runs: GhWorkflowRun[],
): Promise<void> {
  const rows = runs.map((r) => {
    const started = r.run_started_at ?? r.created_at;
    const duration =
      started && r.updated_at
        ? new Date(r.updated_at).getTime() - new Date(started).getTime()
        : null;
    return [
      repoId,
      r.id,
      r.workflow_id ?? null,
      r.name ?? null,
      r.event ?? null,
      r.status ?? null,
      r.conclusion ?? null,
      r.created_at ?? null,
      started ?? null,
      r.updated_at ?? null,
      // A negative span means GitHub restated timestamps; treat it as unknown.
      duration != null && duration >= 0 ? duration : null,
    ];
  });
  await withWriteLock(() =>
    bulkInsert(db, {
      table: "workflow_runs",
      columns: [
        "repo_id",
        "run_id",
        "workflow_id",
        "name",
        "event",
        "status",
        "conclusion",
        "created_at",
        "started_at",
        "updated_at",
        "duration_ms",
      ],
      conflictColumns: ["repo_id", "run_id"],
      rows,
    }),
  );
}
