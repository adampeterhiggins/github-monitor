import { invoke } from "@tauri-apps/api/core";
import type { Identity } from "./lineOwnership";
import type { OwnershipIdentityIndex } from "./ownershipIdentity";

/** One repository's saved HEAD cache, per file and per origin commit. */
export interface OwnershipBreakdownData {
  revision: string;
  people: Identity[];
  /** Author time in Unix seconds; 0 when the clone could not date the commit. */
  commits: Array<{ authoredAt: number; people: number[] }>;
  /** `lines` is flat pairs: commit index, surviving lines. */
  files: Array<{ path: string; lines: number[] }>;
}

export function loadOwnershipBreakdown(fullName: string, cacheRef: string): Promise<OwnershipBreakdownData> {
  return invoke<OwnershipBreakdownData>("line_ownership_breakdown", { githubRepo: fullName, cacheRef });
}

export type BreakdownSplit = "person" | "language" | "directory" | "file" | "age";

export interface BreakdownSlice {
  key: string;
  label: string;
  /** Physical lines, except by person, where co-authored lines are divided between the people on them. */
  lines: number;
  /** Of the lines in scope. Slices always sum to the whole. */
  share: number;
  files: number;
  people: number;
  /** By person only: every line the person is on, co-authored or not. */
  creditedLines?: number;
  /** Directories: the prefix to drill into. */
  directory?: string;
  /** People: the account or unmatched key, for joining with other views. */
  personKey?: string;
}

export interface OwnershipBreakdown {
  /** Surviving lines in scope with at least one selected person. */
  totalLines: number;
  files: number;
  people: number;
  coauthoredLines: number;
  /** Line-weighted, in days; null when no commit could be dated. */
  medianAgeDays: number | null;
  oldest: number | null;
  newest: number | null;
  slices: BreakdownSlice[];
  /** Lines per person (by label) inside each slice. Rows follow `people`, columns follow `slices`. */
  matrix: { people: Array<{ key: string; label: string; lines: number }>; values: number[][] };
}

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", pyi: "Python", ipynb: "Jupyter", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", kts: "Kotlin",
  scala: "Scala", swift: "Swift", m: "Objective-C", mm: "Objective-C", c: "C", h: "C/C++ header", hpp: "C/C++ header",
  cc: "C++", cpp: "C++", cxx: "C++", cs: "C#", fs: "F#", rb: "Ruby", php: "PHP", ex: "Elixir", exs: "Elixir",
  erl: "Erlang", hs: "Haskell", clj: "Clojure", lua: "Lua", dart: "Dart", r: "R", jl: "Julia", pl: "Perl",
  sh: "Shell", bash: "Shell", zsh: "Shell", fish: "Shell", ps1: "PowerShell",
  sql: "SQL", prisma: "Prisma", graphql: "GraphQL", gql: "GraphQL", proto: "Protobuf",
  html: "HTML", htm: "HTML", vue: "Vue", svelte: "Svelte", astro: "Astro",
  css: "CSS", scss: "SCSS", sass: "SCSS", less: "Less",
  md: "Markdown", mdx: "Markdown", rst: "reStructuredText", txt: "Text",
  json: "JSON", jsonc: "JSON", json5: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML", ini: "INI",
  csv: "CSV", tf: "Terraform", hcl: "Terraform", svg: "SVG", dockerfile: "Dockerfile",
};
const NAMED_FILES: Record<string, string> = {
  dockerfile: "Dockerfile", makefile: "Makefile", gemfile: "Ruby", rakefile: "Ruby", justfile: "Just",
  ".gitignore": "Git config", ".gitattributes": "Git config", ".editorconfig": "Config", ".env.example": "Config",
};

export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  if (NAMED_FILES[lower]) return NAMED_FILES[lower];
  if (lower.startsWith("dockerfile")) return "Dockerfile";
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return "No extension";
  const ext = lower.slice(dot + 1);
  return LANGUAGES[ext] ?? `.${ext}`;
}

const DAY = 86_400;
/** Age bands, youngest first. Upper bounds in days. */
export const AGE_BANDS: Array<{ key: string; label: string; maxDays: number }> = [
  { key: "age:0", label: "Under 1 month", maxDays: 30 },
  { key: "age:1", label: "1–6 months", maxDays: 182 },
  { key: "age:2", label: "6–12 months", maxDays: 365 },
  { key: "age:3", label: "1–2 years", maxDays: 730 },
  { key: "age:4", label: "2–5 years", maxDays: 1826 },
  { key: "age:5", label: "5+ years", maxDays: Number.POSITIVE_INFINITY },
];
const UNDATED = { key: "age:none", label: "Undated" };

function ageBand(authoredAt: number, nowSeconds: number): { key: string; label: string } {
  if (!authoredAt) return UNDATED;
  const days = Math.max(0, (nowSeconds - authoredAt) / DAY);
  return AGE_BANDS.find((band) => days < band.maxDays) ?? AGE_BANDS[AGE_BANDS.length - 1];
}

/** `prefix` is a directory ("src/lib/") or "" for the whole repository. */
function inScope(path: string, prefix: string): boolean {
  return prefix === "" || path.startsWith(prefix);
}

/**
 * Break one repository's surviving lines down by a dimension, inside a
 * directory scope. People resolve through the page's identity index, so the
 * same account is the same person here as in every other ownership view.
 * A line counts when at least one selected person is on it; by person, its
 * weight is divided between those people so every split sums to the total.
 */
export function breakdownOwnership(
  data: OwnershipBreakdownData,
  options: {
    split: BreakdownSplit;
    identity: OwnershipIdentityIndex;
    repoId: number | null;
    selection: ReadonlySet<number> | null;
    prefix?: string;
    nowMs?: number;
    matrixPeople?: number;
  },
): OwnershipBreakdown {
  const { split, identity, repoId, selection } = options;
  const prefix = options.prefix ?? "";
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  // Each raw identity once, then each commit's distinct selected people.
  const personOf = data.people.map((p) => identity.personOf({ ...p, repoId }));
  const commitPeople = data.commits.map((commit) => {
    const people: number[] = [];
    for (const raw of commit.people) {
      const person = personOf[raw];
      if (person == null || (selection && !selection.has(person)) || people.includes(person)) continue;
      people.push(person);
    }
    return people;
  });
  const resolved = identity.people;

  interface Acc { key: string; label: string; lines: number; credited: number; files: Set<number>; people: Set<number>; directory?: string; personKey?: string; byPerson: Map<number, number> }
  const groups = new Map<string, Acc>();
  const group = (key: string, label: string, extra?: Partial<Acc>): Acc => {
    let acc = groups.get(key);
    if (!acc) groups.set(key, acc = { key, label, lines: 0, credited: 0, files: new Set(), people: new Set(), byPerson: new Map(), ...extra });
    return acc;
  };
  const personTotals = new Map<number, number>();
  let totalLines = 0;
  let coauthoredLines = 0;
  let files = 0;
  const everyone = new Set<number>();
  const dated: Array<[number, number]> = [];

  data.files.forEach((file, fileIndex) => {
    if (!inScope(file.path, prefix)) return;
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    let fileGroup: Acc | null = null;
    if (split === "language") {
      const language = languageOf(file.path);
      fileGroup = group(`lang:${language}`, language);
    } else if (split === "directory") {
      fileGroup = slash < 0
        ? group("dir:", prefix ? `Files in ${prefix}` : "Files in root")
        : group(`dir:${rest.slice(0, slash)}`, `${rest.slice(0, slash)}/`, { directory: `${prefix}${rest.slice(0, slash + 1)}` });
    } else if (split === "file") {
      fileGroup = group(`file:${file.path}`, rest || file.path);
    }
    let fileLines = 0;
    for (let i = 0; i < file.lines.length; i += 2) {
      const commit = file.lines[i];
      const lines = file.lines[i + 1];
      const people = commitPeople[commit];
      if (!people?.length) continue;
      fileLines += lines;
      totalLines += lines;
      if (people.length > 1) coauthoredLines += lines;
      const authoredAt = data.commits[commit].authoredAt;
      if (authoredAt) dated.push([authoredAt, lines]);
      const portion = lines / people.length;
      for (const person of people) {
        everyone.add(person);
        personTotals.set(person, (personTotals.get(person) ?? 0) + portion);
      }
      const targets: Acc[] = [];
      if (fileGroup) targets.push(fileGroup);
      else if (split === "age") {
        const band = ageBand(authoredAt, now);
        targets.push(group(band.key, band.label));
      }
      if (split === "person") {
        for (const person of people) {
          const p = resolved[person] ?? identity.person(person);
          const acc = group(`person:${p.key}`, p.label, { personKey: p.key });
          acc.lines += portion;
          acc.credited += lines;
          acc.files.add(fileIndex);
          acc.people.add(person);
          acc.byPerson.set(person, (acc.byPerson.get(person) ?? 0) + portion);
        }
        continue;
      }
      for (const acc of targets) {
        acc.lines += lines;
        acc.files.add(fileIndex);
        for (const person of people) {
          acc.people.add(person);
          acc.byPerson.set(person, (acc.byPerson.get(person) ?? 0) + portion);
        }
      }
    }
    if (fileLines > 0) files++;
  });

  const ageOrder = new Map<string, number>([...AGE_BANDS.map((b, i) => [b.key, i] as const), [UNDATED.key, AGE_BANDS.length]]);
  const slices: BreakdownSlice[] = [...groups.values()].filter((acc) => acc.lines > 0).map((acc) => ({
    key: acc.key,
    label: acc.label,
    lines: acc.lines,
    share: totalLines ? acc.lines / totalLines : 0,
    files: acc.files.size,
    people: acc.people.size,
    ...(split === "person" ? { creditedLines: acc.credited, personKey: acc.personKey } : {}),
    ...(acc.directory ? { directory: acc.directory } : {}),
  }));
  slices.sort(split === "age"
    ? (a, b) => (ageOrder.get(a.key) ?? 99) - (ageOrder.get(b.key) ?? 99)
    : (a, b) => b.lines - a.lines || a.label.localeCompare(b.label));

  const topPeople = [...personTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, options.matrixPeople ?? 12);
  const matrixPeople = topPeople.map(([person, lines]) => ({ key: resolved[person]?.key ?? String(person), label: resolved[person]?.label ?? "Unknown", lines }));
  const values = topPeople.map(([person]) => slices.map((slice) => groups.get(slice.key)!.byPerson.get(person) ?? 0));

  let medianAgeDays: number | null = null;
  let oldest: number | null = null;
  let newest: number | null = null;
  if (dated.length) {
    dated.sort((a, b) => a[0] - b[0]);
    oldest = dated[0][0] * 1000;
    newest = dated[dated.length - 1][0] * 1000;
    const half = dated.reduce((n, [, lines]) => n + lines, 0) / 2;
    let seen = 0;
    for (const [time, lines] of dated) {
      seen += lines;
      if (seen >= half) { medianAgeDays = Math.max(0, (now - time) / DAY); break; }
    }
  }
  return { totalLines, files, people: everyone.size, coauthoredLines, medianAgeDays, oldest, newest, slices, matrix: { people: matrixPeople, values } };
}

/** Keep the largest slices and fold the rest into one Other slice. Age keeps its order. */
export function foldSlices(slices: readonly BreakdownSlice[], keep: number, total: number): BreakdownSlice[] {
  if (slices.length <= keep) return [...slices];
  const kept = slices.slice(0, keep - 1);
  const rest = slices.slice(keep - 1);
  const lines = rest.reduce((n, s) => n + s.lines, 0);
  return [...kept, {
    key: "other", label: `Other (${rest.length})`, lines, share: total ? lines / total : 0,
    files: rest.reduce((n, s) => n + s.files, 0), people: 0,
  }];
}
