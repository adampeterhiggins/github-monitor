import { bucketStart, type Granularity } from "./agg/series";
import { weekStart } from "./agg/weeks";
import { CSV_FILE, JSON_FILE, saveTextFile } from "./saveFile";
import {
  isBotPerson, normalizeEmail, normalizeName, OwnershipIdentityIndex, selectOwnershipPeople, toAccountIndex, withNoreplyLogins,
  type MatchSource, type OwnershipAccountIndex,
} from "./ownershipIdentity";

export interface Identity { name: string; email: string }
export interface LineCredit { lines: number; people: Identity[] }
export interface OwnershipAuthor {
  author: string;
  names: string[];
  emails: string[];
  lines: number;
  share: number;
}
export interface OwnershipReport {
  repo: string;
  revision: string;
  filesBlamed: number;
  filesSkipped: Record<string, number>;
  totalLines: number;
  creditedLines: number;
  coauthoredLines: number;
  authors: OwnershipAuthor[];
  credits: LineCredit[];
  filesReused: number;
  filesRecalculated: number;
}
export type GroupBy = "person" | "email" | "name";

/** A legacy history row. Rust used to merge identities by name before saving these. */
export interface OwnershipHistoryAuthor {
  author: string;
  names: string[];
  emails: string[];
  lines: number;
}

export interface OwnershipHistoryPoint {
  repoId: number;
  committedAt: string;
  authors: OwnershipHistoryAuthor[];
}

export interface OwnershipHistorySeries {
  data: Array<Record<string, number>>;
  series: Array<{ key: string; label: string; slot: number | null }>;
}

export type OwnershipHistorySplit = "people" | "repository" | "total";

/** How the chart reads a stock: the level owned, or the change during the period. */
export type OwnershipReading = "cumulative" | "period";

/** How wide each point is. Independent of whether the point is a level or a change. */
export type OwnershipPeriod = "day" | Granularity;

/** A git email the commits API has matched to a GitHub account. */
export interface GithubAccount {
  login: string;
  id: string;
}

export type GithubAccounts = ReadonlyMap<string, GithubAccount>;

/** Accounts as a full index, a legacy email map, or an identity index already built for these reports. */
export type OwnershipAccounts = OwnershipAccountIndex | GithubAccounts | OwnershipIdentityIndex;

export interface OwnershipSummaryAuthor extends OwnershipAuthor {
  key: string;
  /** Person grouping only: whether the row is a GitHub account. */
  matched: boolean | null;
  login: string | null;
  githubId: string | null;
  sources: MatchSource[];
}

export interface OwnershipSummary {
  authors: OwnershipSummaryAuthor[];
  /** Physical surviving lines with at least one selected person. */
  totalLines: number;
  /** One credit per resolved person (or group) per line; co-authors can make this exceed totalLines. */
  creditedLines: number;
  coauthoredLines: number;
  byRepository: Array<{ totalLines: number; coauthoredLines: number; authors: OwnershipSummaryAuthor[] }>;
  identity: OwnershipIdentityIndex;
}

/** Per report, the person index of every credited identity. Reused while the identity index lives. */
const personCache = new WeakMap<OwnershipReport, { index: OwnershipIdentityIndex; repoId: number | null; people: Int32Array[] }>();

function reportPeople(report: OwnershipReport, index: OwnershipIdentityIndex, repoId: number | null): Int32Array[] {
  const cached = personCache.get(report);
  if (cached && cached.index === index && cached.repoId === repoId) return cached.people;
  const people = report.credits.map((credit) => Int32Array.from(credit.people, (p) => index.personOf({ ...p, repoId }, credit.lines)));
  personCache.set(report, { index, repoId, people });
  return people;
}

/** Resolve every credited identity across the selection once. Labels weigh by surviving lines. */
export function ownershipIdentity(
  reports: readonly OwnershipReport[],
  accounts?: OwnershipAccounts,
  repoIds?: readonly number[],
): OwnershipIdentityIndex {
  if (accounts instanceof OwnershipIdentityIndex) return accounts;
  const emails = reports.flatMap((r) => r.credits.flatMap((c) => c.people.map((p) => p.email)));
  const index = new OwnershipIdentityIndex(withNoreplyLogins(toAccountIndex(accounts), emails));
  reports.forEach((report, i) => reportPeople(report, index, repoIds?.[i] ?? null));
  return index;
}

/**
 * Resolve people over the whole selection before assigning credit, then apply the
 * contributor selection to people, then group for presentation. A line is credited
 * once to each group it reaches, so an author and co-author who are one account
 * count once, and two different people each count.
 */
export function aggregateOwnership(
  reports: readonly OwnershipReport[],
  groupBy: GroupBy = "person",
  selectedContributors: readonly string[] = [],
  accounts?: OwnershipAccounts,
  repoIds?: readonly number[],
): OwnershipSummary {
  const identity = ownershipIdentity(reports, accounts, repoIds);
  const perReport = reports.map((report, i) => reportPeople(report, identity, repoIds?.[i] ?? null));
  const people = identity.people;
  const selection = selectOwnershipPeople(identity, selectedContributors);
  const groupKey = (person: number, raw: Identity): string => {
    if (groupBy === "person") return people[person].key;
    const email = normalizeEmail(raw.email);
    const name = normalizeName(raw.name);
    return groupBy === "email" ? (email ? `email:${email}` : name ? `name:${name}` : "")
      : name ? `name:${name}` : email ? `email:${email}` : "";
  };
  interface Row { names: Set<string>; emails: Set<string>; display: Map<string, number>; person: number | null; lines: number }
  const rows = new Map<string, Row>();
  let totalLines = 0;
  let coauthoredLines = 0;
  const repositoryCounts = reports.map((report, r) => {
    const counts = new Map<string, number>();
    let repositoryLines = 0;
    let repositoryCoauthored = 0;
    report.credits.forEach((credit, c) => {
      const ids = perReport[r][c];
      const seen = new Set<string>();
      credit.people.forEach((raw, i) => {
        const person = ids[i];
        if (selection && !selection.has(person)) return;
        const key = groupKey(person, raw);
        if (!key) return;
        let row = rows.get(key);
        if (!row) rows.set(key, row = { names: new Set(), emails: new Set(), display: new Map(), person: groupBy === "person" ? person : null, lines: 0 });
        if (raw.name) {
          row.names.add(raw.name);
          row.display.set(raw.name, (row.display.get(raw.name) ?? 0) + credit.lines);
        }
        if (raw.email) row.emails.add(normalizeEmail(raw.email));
        if (!seen.has(key)) {
          seen.add(key);
          row.lines += credit.lines;
          counts.set(key, (counts.get(key) ?? 0) + credit.lines);
        }
      });
      if (seen.size > 0) repositoryLines += credit.lines;
      if (seen.size > 1) repositoryCoauthored += credit.lines;
    });
    totalLines += repositoryLines;
    coauthoredLines += repositoryCoauthored;
    return { counts, totalLines: repositoryLines, coauthoredLines: repositoryCoauthored };
  });
  const authors: OwnershipSummaryAuthor[] = [...rows.entries()].map(([key, row]) => {
    const names = [...row.names].sort();
    const emails = [...row.emails].sort();
    const person = row.person != null ? people[row.person] : null;
    let author: string;
    if (person) author = person.label;
    else {
      const name = [...row.display.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? emails[0] ?? "Unknown";
      author = groupBy === "email" && emails[0] ? `${name} <${emails[0]}>` : name;
    }
    return {
      key, author,
      names: person ? [...new Set([...names, ...person.names])].sort() : names,
      emails: person ? [...new Set([...emails, ...person.emails])].sort() : emails,
      lines: row.lines,
      share: totalLines ? row.lines / totalLines : 0,
      matched: person ? person.matched : null,
      login: person?.login ?? null,
      githubId: person?.githubId ?? null,
      sources: person?.sources ?? [],
    };
  }).sort((a, b) => b.lines - a.lines || a.author.localeCompare(b.author));
  const byRepository = repositoryCounts.map((repo) => ({
    totalLines: repo.totalLines,
    coauthoredLines: repo.coauthoredLines,
    authors: authors.filter((a) => repo.counts.has(a.key)).map((a) => ({
      ...a, lines: repo.counts.get(a.key)!, share: repo.totalLines ? repo.counts.get(a.key)! / repo.totalLines : 0,
    })).sort((a, b) => b.lines - a.lines || a.author.localeCompare(b.author)),
  }));
  return { authors, totalLines, creditedLines: authors.reduce((n, a) => n + a.lines, 0), coauthoredLines, byRepository, identity };
}

interface GithubCommitSide {
  login?: string | null;
  id?: number | null;
}

/** The account on one side of a commit. A matching email with no user is a miss.
 * An email from the other side is left unresolved so the next sync can try again. */
export function githubUserForCommit(
  commit: {
    author: GithubCommitSide | null;
    committer: GithubCommitSide | null;
    commit?: { author?: { email?: string | null } | null; committer?: { email?: string | null } | null } | null;
  } | null,
  sample: { email: string; role: string },
): { matched: boolean; account: GithubAccount | null } {
  if (!commit) return { matched: true, account: null };
  const committer = sample.role === "committer";
  const user = committer ? commit.committer : commit.author;
  const email = (committer ? commit.commit?.committer?.email : commit.commit?.author?.email) ?? "";
  if (email.trim().toLowerCase() !== sample.email.trim().toLowerCase()) return { matched: false, account: null };
  const login = user?.login?.trim() ?? "";
  if (!login || user?.id == null) return { matched: true, account: null };
  return { matched: true, account: { login, id: String(user.id) } };
}

/** Sample the stock at the end of each period, then optionally turn those levels
 * into the change since the previous point. Summing a stock would count the
 * same lines once per day. The first change is measured from zero, which is the
 * empty tree the history walk starts from. */
export function ownershipHistoryBuckets(
  rows: ReadonlyArray<Record<string, number>>,
  keys: readonly string[],
  period: OwnershipPeriod,
  reading: OwnershipReading = "cumulative",
): Array<Record<string, number>> {
  if (rows.length === 0) return [];
  const levels = period === "day" ? rows.map((row) => {
    const next: Record<string, number> = { week: row.week };
    for (const key of keys) next[key] = row[key] ?? 0;
    return next;
  }) : samplePeriodEnd(rows, keys, period);
  if (reading === "cumulative") return levels;
  return levels.map((row, index) => {
    const previous = levels[index - 1];
    const next: Record<string, number> = { week: row.week };
    for (const key of keys) next[key] = (row[key] ?? 0) - (previous?.[key] ?? 0);
    return next;
  });
}

function samplePeriodEnd(
  rows: ReadonlyArray<Record<string, number>>,
  keys: readonly string[],
  period: Granularity,
): Array<Record<string, number>> {
  const buckets = new Map<number, Record<string, number>>();
  for (const row of rows) {
    const start = period === "week" ? weekStart(row.week * 1000) : bucketStart(row.week, period);
    const next: Record<string, number> = { week: start };
    for (const key of keys) next[key] = row[key] ?? 0;
    buckets.set(start, next);
  }
  return [...buckets.values()].sort((a, b) => a.week - b.week);
}

/** Selector rows for snapshot pages. Accounts use the Contributors login; unmatched people a prefixed token. */
export interface OwnershipContributorOption {
  login: string;
  label: string;
  aliases: string[];
  searchText: string[];
  commits: number;
  commits_all: number;
  repos: number;
  isBot: boolean;
  unmatched: boolean;
}

export function ownershipContributors(
  reports: OwnershipReport[],
  botPatterns: readonly string[] = [],
  accounts?: OwnershipAccounts,
  repoIds?: readonly number[],
): OwnershipContributorOption[] {
  return contributorsFromOwnership(aggregateOwnership(reports, "person", [], accounts, repoIds), botPatterns);
}

/** The person summary already walked every credit, so the selector can reuse it. */
export function contributorsFromOwnership(
  summary: OwnershipSummary,
  botPatterns: readonly string[] = [],
): OwnershipContributorOption[] {
  const repositoryCounts = new Map<string, number>();
  for (const repo of summary.byRepository) for (const author of repo.authors) {
    repositoryCounts.set(author.key, (repositoryCounts.get(author.key) ?? 0) + 1);
  }
  const people = new Map(summary.identity.people.map((p) => [p.key, p]));
  return summary.authors.flatMap((author) => {
    const person = people.get(author.key);
    if (!person) return [];
    const token = person.matched && person.login ? person.login : person.key;
    return [{
      login: token,
      label: person.label,
      aliases: person.selectionTokens.filter((t) => t !== token.toLowerCase()),
      searchText: [...person.names, ...person.emails, ...(person.login ? [person.login] : [])],
      commits: author.lines,
      commits_all: author.lines,
      repos: repositoryCounts.get(author.key) ?? 0,
      isBot: isBotPerson(person, botPatterns),
      unmatched: !person.matched,
    }];
  });
}

/** Exports keep the resolved account next to each row, so a reader can audit the join. */
export function ownershipCsv(report: { authors: Array<OwnershipAuthor & Partial<Pick<OwnershipSummaryAuthor, "login" | "matched" | "sources">>>; totalLines: number; creditedLines?: number }): string {
  const cell = (value: string | number) => {
    let text = String(value);
    if (typeof value === "string" && /^\s*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const account = (a: Partial<Pick<OwnershipSummaryAuthor, "login" | "matched" | "sources">>) =>
    a.matched == null ? "" : a.matched ? a.login ?? "" : "unmatched";
  const rows: (string | number)[][] = [
    ["author", "lines", "share", "emails", "account", "match"],
    ...report.authors.map((a) => [a.author, a.lines, a.share, a.emails.join(";"), account(a), (a.sources ?? []).join(";")]),
    ["Surviving lines", report.totalLines, "", "", "", ""],
    ...(report.creditedLines != null ? [["Credited lines", report.creditedLines, "", "", "", ""]] : []),
  ];
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Save through the system dialog. Resolves to the saved path, or null when cancelled. */
export function downloadOwnership(report: { authors: OwnershipAuthor[]; totalLines: number; creditedLines?: number }, format: "json" | "csv"): Promise<string | null> {
  const body = format === "json" ? JSON.stringify(report, null, 2) + "\n" : ownershipCsv(report);
  return saveTextFile({ name: `line-ownership-${new Date().toISOString().slice(0, 10)}.${format}`, contents: body, ...(format === "json" ? JSON_FILE : CSV_FILE) });
}

export {
  coarsenPlotRows, legacyHistory, normalizeRepoHistory, ownershipHistorySeries, plotBudget, projectOwnershipHistory,
  resolveOwnershipPeople,
} from "./ownershipHistory";
