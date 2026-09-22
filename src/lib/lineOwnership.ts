import { bucketStart, type Granularity } from "./agg/series";
import { weekStart } from "./agg/weeks";
import { isBotIdentity } from "./bots";

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

export interface OwnershipHistorySeriesOptions {
  /** Series drawn on their own before the rest become Other. Defaults to eight. */
  limit?: number;
  /** People across repositories, one series per repository, or a single total. */
  split?: OwnershipHistorySplit;
  repoNames?: ReadonlyMap<number, string>;
  /** Personal emails joined to the account GitHub recorded on a commit. */
  accounts?: GithubAccounts;
}

/** Merge identities over the whole selection before assigning credit, so an
 * alias connecting two co-authors across repositories cannot double-count a line. */
export function aggregateOwnership(reports: OwnershipReport[], groupBy: GroupBy = "person", selectedContributors: readonly string[] = [], accounts?: GithubAccounts) {
  const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const keyOf = (p: Identity) => p.email ? `email:${p.email.toLowerCase()}` : `name:${normalize(p.name)}`;
  const parents = new Map<string, string>();
  const names = new Map<string, string>();
  const logins = new Map<string, string>();
  const githubIds = new Map<string, string>();
  const root = (key: string): string => {
    let current = key;
    while (parents.has(current) && parents.get(current) !== current) current = parents.get(current)!;
    return current;
  };
  const link = (index: Map<string, string>, token: string, key: string) => {
    if (!token) return;
    const existing = index.get(token);
    if (existing) parents.set(root(key), root(existing));
    else index.set(token, key);
  };
  const credits = reports.flatMap((r) => r.credits);
  const identities = new Map<string, Identity>();
  for (const { people } of credits) for (const p of people) identities.set(JSON.stringify([p.name, p.email.toLowerCase()]), p);
  for (const p of identities.values()) {
    const key = keyOf(p);
    if (!parents.has(key)) parents.set(key, key);
    link(names, normalize(p.name), key);
    const account = linkedAccount(p.email, accounts);
    if (!account) continue;
    link(logins, account.login, key);
    if (account.id) link(githubIds, account.id, key);
  }
  const groupKey = (p: Identity) => groupBy === "person" ? root(keyOf(p)) : groupBy === "email"
    ? p.email.toLowerCase() || normalize(p.name) : normalize(p.name) || p.email.toLowerCase();
  // Resolve selection as people before applying the presentation grouping. A
  // GitHub login selected elsewhere must include all of that person's aliases.
  const selected = new Set(selectedContributors.map((value) => value.toLowerCase()));
  const selectedPeople = new Set<string>();
    if (selected.size) for (const p of identities.values()) {
    if (identitySelections(p, accounts).some((value) => selected.has(value.toLowerCase()))) selectedPeople.add(root(keyOf(p)));
  }
  const authors = new Map<string, { names: Set<string>; emails: Set<string>; logins: Map<string, number>; lines: number }>();
  let totalLines = 0;
  let coauthoredLines = 0;
  const repositoryCounts = reports.map((report) => {
    const counts = new Map<string, number>();
    let repositoryLines = 0;
    let repositoryCoauthored = 0;
    for (const credit of report.credits) {
      const seen = new Set<string>();
      for (const p of credit.people) {
        const key = groupKey(p);
        if (!key || (selected.size > 0 && !selectedPeople.has(root(keyOf(p))))) continue;
        const author = authors.get(key) ?? { names: new Set<string>(), emails: new Set<string>(), logins: new Map<string, number>(), lines: 0 };
        if (p.name) author.names.add(p.name);
        if (p.email) author.emails.add(p.email.toLowerCase());
        if (!seen.has(key)) {
          author.lines += credit.lines;
          counts.set(key, (counts.get(key) ?? 0) + credit.lines);
          const login = credit.people
            .filter((person) => groupKey(person) === key)
            .map((person) => linkedAccount(person.email, accounts)?.login)
            .find((login): login is string => login != null);
          if (login) author.logins.set(login, (author.logins.get(login) ?? 0) + credit.lines);
        }
        seen.add(key);
        authors.set(key, author);
      }
      if (seen.size > 0) repositoryLines += credit.lines;
      if (seen.size > 1) repositoryCoauthored += credit.lines;
    }
    totalLines += repositoryLines;
    coauthoredLines += repositoryCoauthored;
    return { counts, totalLines: repositoryLines, coauthoredLines: repositoryCoauthored };
  });
  const rows = [...authors.entries()].map(([key, a]) => {
    const names = [...a.names].sort();
    const emails = [...a.emails].sort();
    const login = groupBy === "person" ? preferredLogin(a.logins) : null;
    const name = login ?? (groupBy === "person" ? names.find((n) => n.includes(" ")) : null) ?? names[0] ?? emails[0] ?? "Unknown";
    return { key, author: groupBy === "email" && emails[0] ? `${name} <${emails[0]}>` : name,
      names, emails, lines: a.lines, share: totalLines ? a.lines / totalLines : 0 };
  }).sort((a, b) => b.lines - a.lines || a.author.localeCompare(b.author));
  const byRepository = repositoryCounts.map((repo) => ({
    totalLines: repo.totalLines,
    coauthoredLines: repo.coauthoredLines,
    authors: rows.filter((a) => repo.counts.has(a.key)).map((a) => ({
      ...a, lines: repo.counts.get(a.key)!, share: repo.totalLines ? repo.counts.get(a.key)! / repo.totalLines : 0,
    })).sort((a, b) => b.lines - a.lines || a.author.localeCompare(b.author)),
  }));
  return { authors: rows, totalLines, creditedLines: rows.reduce((n, a) => n + a.lines, 0), coauthoredLines, byRepository };
}

/** One GitHub account. The id-less form and `id+login` are the same account, and the id survives a login rename. */
function githubAccount(email: string): { id: string | null; login: string } | null {
  const match = email.trim().toLowerCase().match(/^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/);
  if (!match?.[2]) return null;
  return { id: match[1] ?? null, login: match[2] };
}

/** Noreply addresses carry the account. Other addresses use the commits API map. */
function linkedAccount(email: string, accounts?: GithubAccounts): { id: string | null; login: string } | null {
  const parsed = githubAccount(email);
  if (parsed) return parsed;
  const resolved = accounts?.get(email.trim().toLowerCase());
  if (!resolved?.login || !resolved.id) return null;
  return { id: resolved.id, login: resolved.login };
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

/** The login contributions would show. The address with the most surviving lines wins a rename. */
function preferredLogin(logins: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestLines = -1;
  for (const [login, lines] of logins) {
    if (lines > bestLines || (lines === bestLines && (best == null || login < best))) {
      best = login;
      bestLines = lines;
    }
  }
  return best;
}

function identitySelections(identity: Identity, accounts?: GithubAccounts): string[] {
  return [identity.name, identity.email, linkedAccount(identity.email, accounts)?.login ?? ""].filter(Boolean);
}

const DAY = 86_400;
const normalizeHistoryName = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

function historyAuthorMatches(author: OwnershipHistoryAuthor, selected: ReadonlySet<string>, accounts?: GithubAccounts): boolean {
  if (selected.size === 0) return true;
  const values = [
    author.author,
    ...author.names,
    ...author.emails,
    ...author.emails.map((email) => linkedAccount(email, accounts)?.login ?? ""),
  ];
  return values.some((value) => value && selected.has(value.toLowerCase()));
}

function rankHistorySeries(
  totals: Map<number, Map<string, number>>,
  labelOf: Map<string, string>,
  limit: number,
): OwnershipHistorySeries {
  const peaks = new Map<string, number>();
  for (const people of totals.values()) {
    for (const [key, lines] of people) peaks.set(key, Math.max(peaks.get(key) ?? 0, lines));
  }
  const ranked = [...peaks.entries()]
    .filter(([, lines]) => lines > 0)
    .sort((a, b) => b[1] - a[1] || (labelOf.get(a[0]) ?? "").localeCompare(labelOf.get(b[0]) ?? ""));
  const kept = ranked.slice(0, limit);
  const rest = new Set(ranked.slice(limit).map(([key]) => key));
  const series = [
    ...kept.map(([key], slot) => ({ key, label: labelOf.get(key) ?? "Unknown", slot })),
    ...(rest.size ? [{ key: "other", label: "Other", slot: null as number | null }] : []),
  ];
  const data = [...totals.keys()].sort((a, b) => a - b).map((day) => {
    const people = totals.get(day)!;
    const row: Record<string, number> = { week: day };
    let other = 0;
    for (const [key, lines] of people) if (rest.has(key)) other += lines;
    for (const item of series) row[item.key] = item.key === "other" ? other : people.get(item.key) ?? 0;
    return row;
  });
  return { data, series };
}

/** Daily stocks, joined once. Split, series limit and period are applied later,
 * so those controls do not walk the history again. */
export interface PreparedOwnershipHistory {
  days: number[];
  people: Map<number, Map<string, number>>;
  personLabels: Map<string, string>;
  repositories: Map<number, Map<number, number>>;
}

const EMPTY_HISTORY: PreparedOwnershipHistory = {
  days: [],
  people: new Map(),
  personLabels: new Map(),
  repositories: new Map(),
};

/** Carry each repository's last commit across days without one, and join people
 * who share a name, email or GitHub account. Repository totals are kept beside
 * the people totals so a later split can choose either without repeating this. */
export function prepareOwnershipHistory(
  points: readonly OwnershipHistoryPoint[],
  selectedLogins: readonly string[] = [],
  accounts?: GithubAccounts,
): PreparedOwnershipHistory {
  const selected = selectedLogins.length ? new Set(selectedLogins.map((value) => value.toLowerCase())) : new Set<string>();
  const byRepo = new Map<number, Map<number, { at: number; authors: OwnershipHistoryAuthor[] }>>();
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    const at = Date.parse(point.committedAt);
    if (Number.isNaN(at)) continue;
    const day = Math.floor(at / 1000 / DAY) * DAY;
    min = Math.min(min, day);
    max = Math.max(max, day);
    const authors = point.authors.filter((author) => historyAuthorMatches(author, selected, accounts));
    const days = byRepo.get(point.repoId) ?? new Map();
    const existing = days.get(day);
    if (!existing || at >= existing.at) days.set(day, { at, authors });
    byRepo.set(point.repoId, days);
  }
  if (!Number.isFinite(min)) return EMPTY_HISTORY;

  const carried = new Map<number, Map<number, OwnershipHistoryAuthor[]>>();
  const rows: OwnershipHistoryAuthor[] = [];
  const rowIndex = new Map<OwnershipHistoryAuthor, number>();
  for (const [repoId, days] of byRepo) {
    const commits = [...days.keys()].sort((a, b) => a - b);
    let current: OwnershipHistoryAuthor[] | null = null;
    let index = 0;
    const filled = new Map<number, OwnershipHistoryAuthor[]>();
    for (let day = min; day <= max; day += DAY) {
      if (index < commits.length && commits[index] === day) {
        current = days.get(commits[index])!.authors;
        index += 1;
      }
      if (current && day >= commits[0]) {
        filled.set(day, current);
        for (const author of current) if (!rowIndex.has(author)) {
          rowIndex.set(author, rows.length);
          rows.push(author);
        }
      }
    }
    carried.set(repoId, filled);
  }

  const parent = rows.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) current = parent[current];
    return current;
  };
  const union = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const emailOwner = new Map<string, number>();
  const nameOwner = new Map<string, number>();
  const loginOwner = new Map<string, number>();
  const githubIdOwner = new Map<string, number>();
  const claim = (index: Map<string, number>, token: string, row: number) => {
    if (!token) return;
    const existing = index.get(token);
    if (existing == null) index.set(token, row);
    else union(row, existing);
  };
  rows.forEach((author, index) => {
    for (const email of author.emails) {
      const key = email.toLowerCase();
      if (!key) continue;
      claim(emailOwner, key, index);
      const account = linkedAccount(email, accounts);
      if (!account) continue;
      claim(loginOwner, account.login, index);
      if (account.id) claim(githubIdOwner, account.id, index);
    }
    const names = author.names.length ? author.names : [author.author];
    for (const name of names) claim(nameOwner, normalizeHistoryName(name), index);
  });
  const members = new Map<number, number[]>();
  rows.forEach((_, index) => {
    const root = find(index);
    members.set(root, [...(members.get(root) ?? []), index]);
  });
  const personLabels = new Map<string, string>();
  const keyByAuthor = new Map<OwnershipHistoryAuthor, string>();
  for (const indexes of members.values()) {
    const names = new Set<string>();
    const emails = new Set<string>();
    for (const index of indexes) {
      for (const name of rows[index].names) if (name.trim()) names.add(name.trim());
      if (!rows[index].names.length && rows[index].author.trim()) names.add(rows[index].author.trim());
      for (const email of rows[index].emails) if (email.trim()) emails.add(email.toLowerCase());
    }
    const nameList = [...names].sort((a, b) => a.localeCompare(b));
    const emailList = [...emails].sort();
    const loginLines = new Map<string, number>();
    for (const index of indexes) {
      const found = new Set<string>();
      for (const email of rows[index].emails) {
        const login = linkedAccount(email, accounts)?.login;
        if (login) found.add(login);
      }
      for (const login of found) loginLines.set(login, (loginLines.get(login) ?? 0) + rows[index].lines);
    }
    const key = emailList.length ? `email:${emailList.join("|")}` : `name:${nameList.map(normalizeHistoryName).join("|")}`;
    personLabels.set(key, preferredLogin(loginLines) ?? nameList.find((name) => name.includes(" ")) ?? nameList[0] ?? emailList[0] ?? "Unknown");
    for (const index of indexes) keyByAuthor.set(rows[index], key);
  }

  const people = new Map<number, Map<string, number>>();
  const repositories = new Map<number, Map<number, number>>();
  const days: number[] = [];
  for (let day = min; day <= max; day += DAY) {
    days.push(day);
    const peopleOnDay = new Map<string, number>();
    const reposOnDay = new Map<number, number>();
    for (const [repoId, filled] of carried) {
      const authors = filled.get(day);
      if (!authors) continue;
      let repoLines = 0;
      for (const author of authors) {
        repoLines += author.lines;
        const key = keyByAuthor.get(author);
        if (!key) continue;
        peopleOnDay.set(key, (peopleOnDay.get(key) ?? 0) + author.lines);
      }
      if (repoLines) reposOnDay.set(repoId, repoLines);
    }
    people.set(day, peopleOnDay);
    repositories.set(day, reposOnDay);
  }
  return { days, people, personLabels, repositories };
}

/** Choose people, repositories or a single total, then fold the tail into Other. */
export function projectOwnershipHistory(
  prepared: PreparedOwnershipHistory,
  options: OwnershipHistorySeriesOptions = {},
): OwnershipHistorySeries {
  if (prepared.days.length === 0) return { data: [], series: [] };
  const split = options.split ?? "people";
  const limit = options.limit ?? 8;
  if (split === "people") return rankHistorySeries(prepared.people, prepared.personLabels, limit);
  if (split === "total") {
    const totals = new Map<number, Map<string, number>>();
    for (const day of prepared.days) {
      let lines = 0;
      for (const value of prepared.repositories.get(day)?.values() ?? []) lines += value;
      totals.set(day, new Map([["total", lines]]));
    }
    return rankHistorySeries(totals, new Map([["total", "Lines"]]), 1);
  }
  const totals = new Map<number, Map<string, number>>();
  const labelOf = new Map<string, string>();
  for (const day of prepared.days) {
    const bucket = new Map<string, number>();
    for (const [repoId, lines] of prepared.repositories.get(day) ?? []) {
      const key = `repo:${repoId}`;
      bucket.set(key, lines);
      if (!labelOf.has(key)) labelOf.set(key, options.repoNames?.get(repoId) ?? `Repository ${repoId}`);
    }
    totals.set(day, bucket);
  }
  return rankHistorySeries(totals, labelOf, limit);
}

/** Daily stacked series. Each repository keeps its last commit through days with
 * none, and people who share a name or email are one series across repositories. */
export function ownershipHistorySeries(
  points: readonly OwnershipHistoryPoint[],
  selectedLogins: readonly string[] = [],
  options: OwnershipHistorySeriesOptions = {},
): OwnershipHistorySeries {
  return projectOwnershipHistory(
    prepareOwnershipHistory(points, selectedLogins, options.accounts),
    options,
  );
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

/** Snapshot contributors use the shared selector and selection store. Keep all
 * aliases searchable/selectable, independent of the table's grouping mode. */
export function ownershipContributors(reports: OwnershipReport[], botPatterns: readonly string[] = [], accounts?: GithubAccounts) {
  return contributorsFromOwnership(aggregateOwnership(reports, "person", [], accounts), botPatterns, accounts);
}

/** The person summary already walked every credit, so the selector can reuse it. */
export function contributorsFromOwnership(
  summary: ReturnType<typeof aggregateOwnership>,
  botPatterns: readonly string[] = [],
  accounts?: GithubAccounts,
) {
  const repositoryCounts = new Map<string, number>();
  for (const repo of summary.byRepository) for (const author of repo.authors) {
    repositoryCounts.set(author.key, (repositoryCounts.get(author.key) ?? 0) + 1);
  }
  return summary.authors.map((author) => {
    const logins = [...new Set(author.emails.flatMap((email) => {
      const login = linkedAccount(email, accounts)?.login;
      return login ? [login] : [];
    }))];
    const aliases = [...new Set([...author.names, ...author.emails, ...logins])];
    const login = logins.includes(author.author) ? author.author : logins[0] ?? author.author;
    return {
      login, aliases, commits: author.lines, commits_all: author.lines,
      repos: repositoryCounts.get(author.key) ?? 0,
      isBot: author.names.some((name) => isBotIdentity({ name, email: "" }, botPatterns)) ||
        author.emails.some((email) => isBotIdentity({ name: "", email }, botPatterns)),
    };
  });
}

export function ownershipCsv(report: { authors: OwnershipAuthor[]; totalLines: number }): string {
  const cell = (value: string | number) => {
    let text = String(value);
    if (typeof value === "string" && /^\s*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows: (string | number)[][] = [
    ["author", "lines", "share", "emails"],
    ...report.authors.map((a) => [a.author, a.lines, a.share, a.emails.join(";")]),
    ["Surviving lines", report.totalLines, "", ""],
  ];
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function downloadOwnership(report: { authors: OwnershipAuthor[]; totalLines: number }, format: "json" | "csv") {
  const body = format === "json" ? JSON.stringify(report, null, 2) + "\n" : ownershipCsv(report);
  const url = URL.createObjectURL(new Blob([body], { type: format === "json" ? "application/json" : "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `line-ownership.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
