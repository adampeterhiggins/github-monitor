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

/** Merge identities over the whole selection before assigning credit, so an
 * alias connecting two co-authors across repositories cannot double-count a line. */
export function aggregateOwnership(reports: OwnershipReport[], groupBy: GroupBy = "person", excludeBots = false, botPatterns: readonly string[] = []) {
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
  // Match every alias before crediting lines. A configured `claude` alias also
  // identifies `Claude Fable 5` when both use the same email, in every grouping.
  const botEmails = new Set<string>();
  const botKeys = new Set<string>();
  if (excludeBots) {
    for (const p of identities.values()) {
      if (p.email && isBotIdentity(p, botPatterns)) botEmails.add(p.email.toLowerCase());
    }
    for (const p of identities.values()) {
      if (isBotIdentity(p, botPatterns) || (p.email && botEmails.has(p.email.toLowerCase()))) botKeys.add(groupKey(p));
    }
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
        if (!key || botKeys.has(key)) continue;
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
