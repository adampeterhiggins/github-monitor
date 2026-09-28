import type { OwnershipReport } from "./lineOwnership";
import {
  normalizeEmail, normalizeName, resolveIdentity, withNoreplyLogins, type ManualMapping, type OwnershipAccountIndex,
} from "./ownershipIdentity";

/**
 * The Settings inventory of Git authors and how each resolves. One row per
 * mapping source: an email (all repositories), or an email-less name within one
 * repository. Figures come from the cached HEAD snapshots.
 */

export interface MappingSource {
  kind: "email" | "repo_name";
  /** Normalized email or normalized name. */
  value: string;
  repoId: number | null;
}

export type InventoryStatus = "github" | "provisional" | "manual" | "superseded" | "conflict" | "unmatched";

export interface InventoryRow {
  key: string;
  source: MappingSource;
  names: string[];
  email: string | null;
  repoIds: number[];
  /** Surviving lines credited to this source; a co-authored line credits each co-author. */
  lines: number;
  /** Distinct raw Git identities (name/email pairs) this source covers. */
  identities: number;
  status: InventoryStatus;
  githubId: string | null;
  login: string | null;
  conflictIds: string[];
  manual: ManualMapping | null;
  /** Every repository this source appears in has history that keeps raw identities. */
  historyResolved: boolean;
}

export interface InventoryInput {
  repoId: number;
  report: OwnershipReport;
  /** Whether that repository's shown history is legacy (merged by name) or raw. */
  legacyHistory: boolean;
}

export function sourceKey(source: MappingSource): string {
  return source.kind === "email" ? `email:${source.value}` : `name:${source.repoId}:${source.value}`;
}

export function mappingSource(raw: { name: string; email: string; repoId: number }): MappingSource {
  const email = normalizeEmail(raw.email);
  return email ? { kind: "email", value: email, repoId: null } : { kind: "repo_name", value: normalizeName(raw.name), repoId: raw.repoId };
}

export function mappingInventory(inputs: readonly InventoryInput[], accounts: OwnershipAccountIndex): InventoryRow[] {
  const index = withNoreplyLogins(accounts, inputs.flatMap((i) => i.report.credits.flatMap((c) => c.people.map((p) => p.email))));
  const rows = new Map<string, InventoryRow & { tuples: Set<string>; repos: Set<number>; namesSet: Set<string>; legacy: boolean }>();
  for (const { repoId, report, legacyHistory } of inputs) {
    for (const credit of report.credits) {
      const seen = new Set<string>();
      for (const person of credit.people) {
        const source = mappingSource({ ...person, repoId });
        const key = sourceKey(source);
        let row = rows.get(key);
        if (!row) {
          const resolution = resolveIdentity({ ...person, repoId }, index);
          const status: InventoryStatus = resolution.source === "manual" ? "manual"
            : resolution.source === "github" ? (resolution.superseded ? "superseded" : resolution.githubId ? "github" : "provisional")
            : resolution.conflict ? "conflict" : "unmatched";
          const email = source.kind === "email" ? source.value : null;
          row = {
            key, source, names: [], email, repoIds: [], lines: 0, identities: 0, status,
            githubId: resolution.githubId,
            login: resolution.githubId ? index.users.get(resolution.githubId)?.login ?? resolution.loginHint : resolution.loginHint,
            conflictIds: email ? [...(index.conflicts.get(email) ?? [])] : [],
            manual: resolution.manual ?? resolution.superseded,
            historyResolved: true,
            tuples: new Set(), repos: new Set(), namesSet: new Set(), legacy: false,
          };
          rows.set(key, row);
        }
        row.tuples.add(`${person.name}\0${normalizeEmail(person.email)}`);
        row.repos.add(repoId);
        if (person.name.trim()) row.namesSet.add(person.name.trim());
        row.legacy ||= legacyHistory;
        if (!seen.has(key)) {
          seen.add(key);
          row.lines += credit.lines;
        }
      }
    }
  }
  return [...rows.values()].map(({ tuples, repos, namesSet, legacy, ...row }) => ({
    ...row,
    names: [...namesSet].sort((a, b) => a.localeCompare(b)),
    repoIds: [...repos].sort((a, b) => a - b),
    identities: tuples.size,
    historyResolved: !legacy,
  })).sort((a, b) => b.lines - a.lines || a.key.localeCompare(b.key));
}

/** What saving a mapping for this source would move, from the cached snapshots. */
export function mappingPreview(rows: readonly InventoryRow[], source: MappingSource): { identities: number; lines: number; repositories: number } {
  const row = rows.find((r) => r.key === sourceKey(source));
  return { identities: row?.identities ?? 0, lines: row?.lines ?? 0, repositories: row?.repoIds.length ?? 0 };
}

export function statusLabel(row: Pick<InventoryRow, "status" | "conflictIds">): string {
  switch (row.status) {
    case "github": return "GitHub";
    case "provisional": return "GitHub login, no account ID yet";
    case "manual": return row.conflictIds.length ? "Manual (conflict reviewed)" : "Manual";
    case "superseded": return "Superseded by automatic match";
    case "conflict": return "Conflicting automatic matches";
    case "unmatched": return "Unmatched";
  }
}

/* ── Export and import ─────────────────────────────────────────────────── */

export const MAPPING_FILE_FORMAT = "github-monitor.contributor-mappings";
export const MAPPING_FILE_VERSION = 1;

export interface ExportedMapping {
  matchKind: "email" | "repo_name";
  /** Normalized email, or normalized Git name. */
  matchValue: string;
  /** Name mappings only: the repository, by GitHub ID and by name. */
  repoId?: number;
  repository?: string;
  /** Empty in a to-do entry. Filled in by an export of a saved mapping. */
  githubId: string;
  /** The GitHub login. Enough on its own: import looks up the account ID. */
  login: string;
  reviewedAutoConflict: boolean;
  /** Hints for filling in a to-do entry; ignored on import. */
  gitNames?: string[];
  survivingLines?: number;
  repositories?: string[];
  status?: string;
}

export interface MappingFile {
  format: typeof MAPPING_FILE_FORMAT;
  version: number;
  exportedAt: string;
  instructions?: string;
  mappings: ExportedMapping[];
}

const INSTRUCTIONS = "Entries with an empty login are Git authors GitHub could not match. Fill in the GitHub login for any you "
  + "recognise, leave the rest empty, and import this file in Settings → Contributor mappings. Import looks up the account ID "
  + "for each login and shows a preview before saving anything.";

/**
 * A file another install can import: every saved mapping, then a to-do entry for
 * each author still unmatched or conflicting, with hints for filling it in.
 */
export function exportMappings(
  mappings: readonly ManualMapping[],
  repoName: ReadonlyMap<number, string>,
  index?: OwnershipAccountIndex,
  inventory: readonly InventoryRow[] = [],
): MappingFile {
  const saved = new Set(mappings.map((m) => m.matchKind === "email" ? `email:${m.matchValue}` : `name:${m.repoId}:${m.matchValue}`));
  const todo = inventory.filter((row) => (row.status === "unmatched" || row.status === "conflict") && !saved.has(row.key));
  return {
    format: MAPPING_FILE_FORMAT,
    version: MAPPING_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    instructions: INSTRUCTIONS,
    mappings: [
      ...mappings.map((m) => ({
        matchKind: m.matchKind,
        matchValue: m.matchValue,
        ...(m.matchKind === "repo_name" && m.repoId != null ? { repoId: m.repoId, repository: repoName.get(m.repoId) } : {}),
        githubId: m.githubId,
        login: index?.users.get(m.githubId)?.login ?? m.loginAtSave,
        reviewedAutoConflict: m.reviewedAutoConflict,
      })),
      ...todo.map((row) => ({
        matchKind: row.source.kind,
        matchValue: row.source.value,
        ...(row.source.kind === "repo_name" && row.source.repoId != null ? { repoId: row.source.repoId, repository: repoName.get(row.source.repoId) } : {}),
        githubId: "",
        login: "",
        reviewedAutoConflict: false,
        gitNames: row.names,
        survivingLines: row.lines,
        repositories: row.repoIds.map((id) => repoName.get(id) ?? String(id)),
        status: row.status === "conflict" ? `Conflicting automatic matches: GitHub IDs ${row.conflictIds.join(", ")}` : "Unmatched",
      })),
    ],
  };
}

/** `lookup` rows name a login but no account ID yet; `unfilled` rows are to-dos left empty. */
export type ImportStatus = "new" | "change" | "same" | "lookup" | "unfilled" | "invalid";

export interface ImportInput {
  matchKind: "email" | "repo_name";
  matchValue: string;
  repoId: number | null;
  githubId: string;
  loginAtSave: string;
  reviewedAutoConflict: boolean;
}

export interface ImportRow {
  status: ImportStatus;
  /** Why an invalid row cannot be imported. */
  reason?: string;
  /** Ready to save for new/change/same; without githubId for lookup. */
  input?: ImportInput;
  /** What the row maps, for the preview. */
  label: string;
  /** The account it maps to now, for a change. */
  previous?: string;
}

const keyOf = (m: { matchKind: string; matchValue: string; repoId: number | null }) =>
  m.matchKind === "email" ? `email:${m.matchValue}` : `name:${m.repoId}:${m.matchValue}`;

/** New, change or same, once a row has an account ID. */
export function classifyImport(row: ImportRow, existing: readonly ManualMapping[]): ImportRow {
  if (!row.input || !/^\d+$/.test(row.input.githubId)) return row;
  const saved = existing.find((m) => keyOf(m) === keyOf(row.input!));
  if (!saved) return { ...row, status: "new" };
  if (saved.githubId === row.input.githubId && saved.reviewedAutoConflict === row.input.reviewedAutoConflict) return { ...row, status: "same" };
  return { ...row, status: "change", previous: `@${saved.loginAtSave} (ID ${saved.githubId})` };
}

/**
 * Check an import against the mappings already saved and the repositories this
 * install knows. Nothing is written; login-only rows still need `lookup`.
 */
export function planMappingImport(
  text: string,
  existing: readonly ManualMapping[],
  repos: ReadonlyArray<{ id: number; fullName: string }>,
): { rows: ImportRow[]; error: string | null } {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return { rows: [], error: "This file is not JSON." };
  }
  const f = file as Partial<MappingFile>;
  if (f?.format !== MAPPING_FILE_FORMAT || !Array.isArray(f.mappings)) {
    return { rows: [], error: "This is not a contributor mappings file exported from GitHub Monitor." };
  }
  if (typeof f.version !== "number" || f.version > MAPPING_FILE_VERSION) {
    return { rows: [], error: "This file was exported by a newer version of GitHub Monitor." };
  }
  const byId = new Map(repos.map((r) => [r.id, r]));
  const byName = new Map(repos.map((r) => [r.fullName.toLowerCase(), r]));
  const seen = new Set<string>();
  const rows = f.mappings.map((raw): ImportRow => {
    const m = (raw ?? {}) as Partial<ExportedMapping>;
    const githubId = typeof m.githubId === "string" || typeof m.githubId === "number" ? String(m.githubId).trim() : "";
    const login = typeof m.login === "string" ? m.login.trim().replace(/^@/, "") : "";
    const bad = (reason: string, label = String(m.matchValue ?? "unknown")): ImportRow => ({ status: "invalid", reason, label });
    if (m.matchKind !== "email" && m.matchKind !== "repo_name") return bad("Unknown kind of mapping");
    if (typeof m.matchValue !== "string") return bad("No email or name");
    const value = m.matchKind === "email" ? normalizeEmail(m.matchValue) : normalizeName(m.matchValue);
    if (!value) return bad("No email or name");
    let repoId: number | null = null;
    let label = value;
    if (m.matchKind === "repo_name") {
      const repo = (m.repoId != null ? byId.get(Number(m.repoId)) : undefined)
        ?? (typeof m.repository === "string" ? byName.get(m.repository.toLowerCase()) : undefined);
      if (!repo) {
        if (!githubId && !login) return { status: "unfilled", label };
        return bad(`Repository ${m.repository ?? m.repoId ?? "(none)"} is not in the listed organisations`, value);
      }
      repoId = repo.id;
      label = `${value} · only in ${repo.fullName}`;
    }
    if (!githubId && !login) return { status: "unfilled", label };
    if (githubId && !/^\d+$/.test(githubId)) return bad("The GitHub account ID is not a number", label);
    if (login && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return bad(`${login} is not a GitHub login`, label);
    const key = keyOf({ matchKind: m.matchKind, matchValue: value, repoId });
    if (seen.has(key)) return bad("Listed twice in this file", label);
    seen.add(key);
    const input: ImportInput = { matchKind: m.matchKind, matchValue: value, repoId, githubId, loginAtSave: login, reviewedAutoConflict: m.reviewedAutoConflict === true };
    if (!githubId) return { status: "lookup", input, label };
    if (!login) return bad("No GitHub login", label);
    return classifyImport({ status: "new", input, label }, existing);
  });
  return { rows, error: null };
}

/**
 * Give login-only rows their account IDs. `resolve` returns the account for a
 * login, or an error message. Each distinct login is resolved once.
 */
export async function resolveImportLookups(
  rows: readonly ImportRow[],
  existing: readonly ManualMapping[],
  resolve: (login: string) => Promise<{ id: string; login: string } | string>,
): Promise<ImportRow[]> {
  const answers = new Map<string, Promise<{ id: string; login: string } | string>>();
  const out: ImportRow[] = [];
  for (const row of rows) {
    if (row.status !== "lookup" || !row.input) {
      out.push(row);
      continue;
    }
    const login = row.input.loginAtSave.toLowerCase();
    if (!answers.has(login)) answers.set(login, resolve(row.input.loginAtSave).catch((e) => (e as Error).message));
    const answer = await answers.get(login)!;
    if (typeof answer === "string") out.push({ ...row, status: "invalid", reason: answer, input: undefined });
    else out.push(classifyImport({ ...row, input: { ...row.input, githubId: answer.id, loginAtSave: answer.login } }, existing));
  }
  return out;
}
