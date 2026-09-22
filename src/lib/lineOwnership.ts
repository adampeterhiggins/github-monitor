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

/** Merge identities over the whole selection before assigning credit, so an
 * alias connecting two co-authors across repositories cannot double-count a line. */
export function aggregateOwnership(reports: OwnershipReport[], groupBy: GroupBy = "person", selectedContributors: readonly string[] = []) {
  const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const keyOf = (p: Identity) => p.email ? `email:${p.email.toLowerCase()}` : `name:${normalize(p.name)}`;
  const parents = new Map<string, string>();
  const names = new Map<string, string>();
  const root = (key: string): string => {
    let current = key;
    while (parents.has(current) && parents.get(current) !== current) current = parents.get(current)!;
    return current;
  };
  const credits = reports.flatMap((r) => r.credits);
  const identities = new Map<string, Identity>();
  for (const { people } of credits) for (const p of people) identities.set(JSON.stringify([p.name, p.email.toLowerCase()]), p);
  for (const p of identities.values()) {
    const key = keyOf(p);
    if (!parents.has(key)) parents.set(key, key);
    const name = normalize(p.name);
    if (!name) continue;
    const existing = names.get(name);
    if (existing) parents.set(root(key), root(existing));
    else names.set(name, key);
  }
  const groupKey = (p: Identity) => groupBy === "person" ? root(keyOf(p)) : groupBy === "email"
    ? p.email.toLowerCase() || normalize(p.name) : normalize(p.name) || p.email.toLowerCase();
  // Resolve selection as people before applying the presentation grouping. A
  // GitHub login selected elsewhere must include all of that person's aliases.
  const selected = new Set(selectedContributors.map((value) => value.toLowerCase()));
  const selectedPeople = new Set<string>();
  if (selected.size) for (const p of identities.values()) {
    if (identitySelections(p).some((value) => selected.has(value.toLowerCase()))) selectedPeople.add(root(keyOf(p)));
  }
  const authors = new Map<string, { names: Set<string>; emails: Set<string>; lines: number }>();
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
        const author = authors.get(key) ?? { names: new Set<string>(), emails: new Set<string>(), lines: 0 };
        if (p.name) author.names.add(p.name);
        if (p.email) author.emails.add(p.email.toLowerCase());
        if (!seen.has(key)) {
          author.lines += credit.lines;
          counts.set(key, (counts.get(key) ?? 0) + credit.lines);
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
    const name = (groupBy === "person" ? names.find((n) => n.includes(" ")) : null) ?? names[0] ?? emails[0] ?? "Unknown";
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

/** GitHub noreply addresses provide an explicit login; other addresses do not. */
function githubLogin(email: string): string | null {
  const match = email.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i);
  return match?.[1] ?? null;
}

function identitySelections(identity: Identity): string[] {
  return [identity.name, identity.email, githubLogin(identity.email) ?? ""].filter(Boolean);
}

const DAY = 86_400;
const normalizeHistoryName = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

function historyAuthorMatches(author: OwnershipHistoryAuthor, selected: ReadonlySet<string>): boolean {
  if (selected.size === 0) return true;
  const values = [
    author.author,
    ...author.names,
    ...author.emails,
    ...author.emails.map((email) => githubLogin(email) ?? ""),
  ];
  return values.some((value) => value && selected.has(value.toLowerCase()));
}

/** Daily stacked series. Each repository keeps its last commit through days with
 * none, and people who share a name or email are one series across repositories. */
export function ownershipHistorySeries(
  points: readonly OwnershipHistoryPoint[],
  selectedLogins: readonly string[] = [],
): OwnershipHistorySeries {
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
    const authors = point.authors.filter((author) => historyAuthorMatches(author, selected));
    const days = byRepo.get(point.repoId) ?? new Map();
    const existing = days.get(day);
    if (!existing || at >= existing.at) days.set(day, { at, authors });
    byRepo.set(point.repoId, days);
  }
  if (!Number.isFinite(min)) return { data: [], series: [] };

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
  rows.forEach((author, index) => {
    for (const email of author.emails) {
      const key = email.toLowerCase();
      if (!key) continue;
      const existing = emailOwner.get(key);
      if (existing == null) emailOwner.set(key, index);
      else union(index, existing);
    }
    const names = author.names.length ? author.names : [author.author];
    for (const name of names) {
      const key = normalizeHistoryName(name);
      if (!key) continue;
      const existing = nameOwner.get(key);
      if (existing == null) nameOwner.set(key, index);
      else union(index, existing);
    }
  });
  const members = new Map<number, number[]>();
  rows.forEach((_, index) => {
    const root = find(index);
    members.set(root, [...(members.get(root) ?? []), index]);
  });
  const keyOf = new Map<number, string>();
  const labelOf = new Map<string, string>();
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
    const key = emailList.length ? `email:${emailList.join("|")}` : `name:${nameList.map(normalizeHistoryName).join("|")}`;
    for (const index of indexes) keyOf.set(find(index), key);
    labelOf.set(key, nameList.find((name) => name.includes(" ")) ?? nameList[0] ?? emailList[0] ?? "Unknown");
  }

  const totals = new Map<number, Map<string, number>>();
  for (let day = min; day <= max; day += DAY) {
    const people = new Map<string, number>();
    for (const filled of carried.values()) {
      for (const author of filled.get(day) ?? []) {
        const index = rowIndex.get(author);
        const key = index == null ? undefined : keyOf.get(find(index));
        if (!key) continue;
        people.set(key, (people.get(key) ?? 0) + author.lines);
      }
    }
    totals.set(day, people);
  }
  const peaks = new Map<string, number>();
  for (const people of totals.values()) {
    for (const [key, lines] of people) peaks.set(key, Math.max(peaks.get(key) ?? 0, lines));
  }
  const ranked = [...peaks.entries()]
    .filter(([, lines]) => lines > 0)
    .sort((a, b) => b[1] - a[1] || (labelOf.get(a[0]) ?? "").localeCompare(labelOf.get(b[0]) ?? ""));
  const kept = ranked.slice(0, 8);
  const rest = new Set(ranked.slice(8).map(([key]) => key));
  const series = [
    ...kept.map(([key], slot) => ({ key, label: labelOf.get(key) ?? "Unknown", slot })),
    ...(rest.size ? [{ key: "other", label: "Other", slot: null }] : []),
  ];
  const data = [...totals.keys()].sort((a, b) => a - b).map((day) => {
    const people = totals.get(day)!;
    const row: Record<string, number> = { week: day };
    let other = 0;
    for (const [key, lines] of people) {
      if (rest.has(key)) other += lines;
    }
    for (const item of series) row[item.key] = item.key === "other" ? other : people.get(item.key) ?? 0;
    return row;
  });
  return { data, series };
}

/** Snapshot contributors use the shared selector and selection store. Keep all
 * aliases searchable/selectable, independent of the table's grouping mode. */
export function ownershipContributors(reports: OwnershipReport[], botPatterns: readonly string[] = []) {
  const summary = aggregateOwnership(reports);
  const repositoryCounts = new Map<string, number>();
  for (const repo of summary.byRepository) for (const author of repo.authors) {
    repositoryCounts.set(author.key, (repositoryCounts.get(author.key) ?? 0) + 1);
  }
  return summary.authors.map((author) => {
    const aliases = [...new Set([...author.names, ...author.emails, ...author.emails.map(githubLogin).filter((s): s is string => s != null)])];
    const login = author.emails.map(githubLogin).find((s) => s != null) ?? author.author;
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
