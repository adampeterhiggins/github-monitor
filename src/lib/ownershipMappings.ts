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
  githubId: string;
  login: string;
  reviewedAutoConflict: boolean;
}

export interface MappingFile {
  format: typeof MAPPING_FILE_FORMAT;
  version: number;
  exportedAt: string;
  mappings: ExportedMapping[];
}

/** A file another install can import. Logins are the current ones when known. */
export function exportMappings(
  mappings: readonly ManualMapping[],
  repoName: ReadonlyMap<number, string>,
  index?: OwnershipAccountIndex,
): MappingFile {
  return {
    format: MAPPING_FILE_FORMAT,
    version: MAPPING_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    mappings: mappings.map((m) => ({
      matchKind: m.matchKind,
      matchValue: m.matchValue,
      ...(m.matchKind === "repo_name" && m.repoId != null ? { repoId: m.repoId, repository: repoName.get(m.repoId) } : {}),
      githubId: m.githubId,
      login: index?.users.get(m.githubId)?.login ?? m.loginAtSave,
      reviewedAutoConflict: m.reviewedAutoConflict,
    })),
  };
}

export type ImportStatus = "new" | "change" | "same" | "invalid";

export interface ImportRow {
  status: ImportStatus;
  /** Why an invalid row cannot be imported. */
  reason?: string;
  /** Ready to save, for valid rows. */
  input?: { matchKind: "email" | "repo_name"; matchValue: string; repoId: number | null; githubId: string; loginAtSave: string; reviewedAutoConflict: boolean };
  /** What the row maps, for the preview. */
  label: string;
  /** The account it maps to now, for a change. */
  previous?: string;
}

/**
 * Check an import against the mappings already saved and the repositories this
 * install knows. Nothing is written; the caller saves the rows it accepts.
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
  const current = new Map(existing.map((m) => [m.matchKind === "email" ? `email:${m.matchValue}` : `name:${m.repoId}:${m.matchValue}`, m]));
  const seen = new Set<string>();
  const rows = f.mappings.map((raw): ImportRow => {
    const m = (raw ?? {}) as Partial<ExportedMapping>;
    const githubId = typeof m.githubId === "string" || typeof m.githubId === "number" ? String(m.githubId) : "";
    const login = typeof m.login === "string" ? m.login.trim() : "";
    const bad = (reason: string, label = String(m.matchValue ?? "unknown")): ImportRow => ({ status: "invalid", reason, label });
    if (m.matchKind !== "email" && m.matchKind !== "repo_name") return bad("Unknown kind of mapping");
    if (typeof m.matchValue !== "string") return bad("No email or name");
    const value = m.matchKind === "email" ? normalizeEmail(m.matchValue) : normalizeName(m.matchValue);
    if (!value) return bad("No email or name");
    if (!/^\d+$/.test(githubId)) return bad("No verified GitHub account ID", value);
    if (!login) return bad("No GitHub login", value);
    let repoId: number | null = null;
    let label = value;
    if (m.matchKind === "repo_name") {
      const repo = (m.repoId != null ? byId.get(Number(m.repoId)) : undefined)
        ?? (typeof m.repository === "string" ? byName.get(m.repository.toLowerCase()) : undefined);
      if (!repo) return bad(`Repository ${m.repository ?? m.repoId ?? "(none)"} is not in this organisation`, value);
      repoId = repo.id;
      label = `${value} · only in ${repo.fullName}`;
    }
    const key = m.matchKind === "email" ? `email:${value}` : `name:${repoId}:${value}`;
    if (seen.has(key)) return bad("Listed twice in this file", label);
    seen.add(key);
    const input = { matchKind: m.matchKind, matchValue: value, repoId, githubId, loginAtSave: login, reviewedAutoConflict: m.reviewedAutoConflict === true };
    const saved = current.get(key);
    if (!saved) return { status: "new", input, label };
    if (saved.githubId === githubId && saved.reviewedAutoConflict === input.reviewedAutoConflict) return { status: "same", input, label };
    return { status: "change", input, label, previous: `@${saved.loginAtSave} (ID ${saved.githubId})` };
  });
  return { rows, error: null };
}
