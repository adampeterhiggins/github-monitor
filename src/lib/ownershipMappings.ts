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
