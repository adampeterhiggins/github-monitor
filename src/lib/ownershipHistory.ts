import type { OwnershipHistoryPoint, OwnershipHistorySeries, OwnershipHistorySplit, OwnershipReading } from "./lineOwnership";
import {
  OwnershipIdentityIndex, selectOwnershipPeople, toAccountIndex, withNoreplyLogins, type OwnershipAccountIndex,
} from "./ownershipIdentity";

/**
 * Daily ownership history, from saved rows to chart rows.
 *
 *   normalizeRepoHistory     once per repository history revision
 *   resolveOwnershipPeople   when the selected repositories or account mappings change
 *   selectOwnershipPeople    when the contributor selection changes
 *   projectOwnershipHistory  when split or series limit changes
 *
 * Each repository's days become per-person level changes; the projection sweeps
 * those events across calendar days while carrying totals, so a day without a
 * commit costs one row rather than a walk over every author.
 */

const DAY = 86_400;

/** One identity a repository's history credits. Legacy rows can already combine several. */
export interface RawHistoryIdentity {
  name: string;
  email: string;
  names?: readonly string[];
  emails?: readonly string[];
}

/** One saved day: the lines credited to each group of raw identities who share them. */
export interface RepoHistoryDay {
  committedAt: string;
  revision?: string;
  /** `[raw identity ids, lines]`. Co-authors share a group, so a line is not counted twice. */
  groups: ReadonlyArray<readonly [readonly number[], number]>;
}

export interface RepoHistoryData {
  repoId: number;
  /** Rows written before raw identities were saved. Rust had merged people by name. */
  legacy: boolean;
  /** The walk has not reached the default-branch head, so the latest day is not final. */
  partial?: boolean;
  identities: ReadonlyMap<number, RawHistoryIdentity>;
  days: readonly RepoHistoryDay[];
}

export interface NormalizedRepoHistory {
  repoId: number;
  legacy: boolean;
  partial: boolean;
  identities: ReadonlyMap<number, RawHistoryIdentity>;
  /** UTC day starts in seconds, ascending, one per day with a commit. */
  days: number[];
  groups: Array<ReadonlyArray<readonly [readonly number[], number]>>;
}

const normalized = new WeakMap<RepoHistoryData, NormalizedRepoHistory>();

/** The last commit of each UTC day wins, as the saved-history query chooses it. */
export function normalizeRepoHistory(data: RepoHistoryData): NormalizedRepoHistory {
  const cached = normalized.get(data);
  if (cached) return cached;
  const byDay = new Map<number, { at: number; revision: string; groups: RepoHistoryDay["groups"] }>();
  for (const point of data.days) {
    const at = Date.parse(point.committedAt);
    if (Number.isNaN(at)) continue;
    const day = Math.floor(at / 1000 / DAY) * DAY;
    const existing = byDay.get(day);
    const revision = point.revision ?? "";
    if (!existing || at > existing.at || (at === existing.at && revision >= existing.revision)) {
      byDay.set(day, { at, revision, groups: point.groups });
    }
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const result: NormalizedRepoHistory = {
    repoId: data.repoId,
    legacy: data.legacy,
    partial: data.partial ?? false,
    identities: data.identities,
    days,
    groups: days.map((day) => byDay.get(day)!.groups),
  };
  normalized.set(data, result);
  return result;
}

/** Old `authors_json` rows as one repository's history. Each saved author is one raw unit. */
export function legacyHistory(repoId: number, points: readonly OwnershipHistoryPoint[]): RepoHistoryData {
  const identities = new Map<number, RawHistoryIdentity>();
  const ids = new Map<string, number>();
  const days = points.filter((p) => p.repoId === repoId).map((point) => ({
    committedAt: point.committedAt,
    groups: point.authors.map((author) => {
      const names = author.names.length ? author.names : author.author ? [author.author] : [];
      const emails = author.emails;
      const tuple = JSON.stringify([names, emails]);
      let id = ids.get(tuple);
      if (id == null) {
        id = ids.size;
        ids.set(tuple, id);
        identities.set(id, { name: names[0] ?? "", email: emails[0] ?? "", names, emails });
      }
      return [[id], author.lines] as const;
    }),
  }));
  return { repoId, legacy: true, identities, days };
}

export interface HistoryIdentity {
  index: OwnershipIdentityIndex;
  /** Per repository: raw identity id to person index. */
  personOf: ReadonlyMap<number, ReadonlyMap<number, number>>;
}

/**
 * Resolve every repository's raw identities in one index. Rebuilt when the set of
 * repositories changes: removing a repository must not leave its aliases behind.
 * Labels weigh by the lines each identity owns on its latest day, not per day carried.
 */
export function resolveOwnershipPeople(
  histories: readonly NormalizedRepoHistory[],
  accounts?: OwnershipAccountIndex | ReadonlyMap<string, { login: string; id: string }>,
): HistoryIdentity {
  const emails = histories.flatMap((h) => [...h.identities.values()].flatMap((raw) => raw.emails ?? [raw.email]));
  const index = new OwnershipIdentityIndex(withNoreplyLogins(toAccountIndex(accounts), emails));
  const personOf = new Map<number, Map<number, number>>();
  for (const history of histories) {
    const weights = new Map<number, number>();
    for (const [ids, lines] of history.groups[history.groups.length - 1] ?? []) for (const id of ids) weights.set(id, (weights.get(id) ?? 0) + lines);
    const map = new Map<number, number>();
    for (const [id, raw] of history.identities) {
      const lines = weights.get(id) ?? 0;
      map.set(id, raw.names || raw.emails
        ? index.personOfLegacy(raw.names ?? [raw.name], raw.emails ?? (raw.email ? [raw.email] : []), history.repoId, lines)
        : index.personOf({ name: raw.name, email: raw.email, repoId: history.repoId }, lines));
    }
    personOf.set(history.repoId, map);
  }
  return { index, personOf };
}

interface Events {
  /** Day index relative to the repository's own days array. */
  days: Int32Array;
  keys: Int32Array;
  deltas: Float64Array;
  length: number;
}

class EventBuffer {
  days = new Int32Array(64);
  keys = new Int32Array(64);
  deltas = new Float64Array(64);
  length = 0;
  push(day: number, key: number, delta: number) {
    if (this.length === this.days.length) {
      const grow = <T extends Int32Array | Float64Array>(a: T): T => {
        const next = new (a.constructor as new (n: number) => T)(a.length * 2);
        next.set(a);
        return next;
      };
      this.days = grow(this.days);
      this.keys = grow(this.keys);
      this.deltas = grow(this.deltas);
    }
    this.days[this.length] = day;
    this.keys[this.length] = key;
    this.deltas[this.length] = delta;
    this.length += 1;
  }
}

/** Turn a sequence of full levels into changes. Negative when someone's lines disappear. */
function levelsToEvents(count: number, levelOn: (day: number) => Map<number, number>): Events {
  const out = new EventBuffer();
  let previous = new Map<number, number>();
  for (let d = 0; d < count; d++) {
    const current = levelOn(d);
    for (const [key, lines] of current) {
      const delta = lines - (previous.get(key) ?? 0);
      if (delta !== 0) out.push(d, key, delta);
    }
    for (const [key, lines] of previous) if (!current.has(key) && lines !== 0) out.push(d, key, -lines);
    previous = current;
  }
  return out;
}

const personEventCache = new WeakMap<NormalizedRepoHistory, { identity: HistoryIdentity; events: Events }>();

/** Per-person level changes. Independent of the selection, so contributor changes reuse them. */
function personEvents(history: NormalizedRepoHistory, identity: HistoryIdentity): Events {
  const cached = personEventCache.get(history);
  if (cached?.identity === identity) return cached.events;
  const personOf = identity.personOf.get(history.repoId) ?? new Map<number, number>();
  const seen: number[] = [];
  const events = levelsToEvents(history.days.length, (d) => {
    const level = new Map<number, number>();
    for (const [ids, lines] of history.groups[d]) {
      // One credit per resolved person per line, even when author and co-author are one account.
      seen.length = 0;
      for (const id of ids) {
        const person = personOf.get(id);
        if (person == null || seen.includes(person)) continue;
        seen.push(person);
        level.set(person, (level.get(person) ?? 0) + lines);
      }
    }
    return level;
  });
  personEventCache.set(history, { identity, events });
  return events;
}

/** Physical lines with at least one selected person, as one key. */
function totalEvents(history: NormalizedRepoHistory, identity: HistoryIdentity, selection: ReadonlySet<number> | null, key: number): Events {
  const personOf = identity.personOf.get(history.repoId) ?? new Map<number, number>();
  return levelsToEvents(history.days.length, (d) => {
    let lines = 0;
    for (const [ids, count] of history.groups[d]) {
      if (!selection || ids.some((id) => { const p = personOf.get(id); return p != null && selection.has(p); })) lines += count;
    }
    return lines ? new Map([[key, lines]]) : new Map();
  });
}

export interface HistoryProjectionOptions {
  /** Series drawn on their own before the rest become Other. Defaults to eight. */
  limit?: number;
  /** People across repositories, one series per repository, or a single total. */
  split?: OwnershipHistorySplit;
  repoNames?: ReadonlyMap<number, string>;
}

/**
 * Sweep every repository's events across calendar days, carrying levels.
 * Ranking uses each series' peak day, so a coarser plot cannot change who is
 * drawn and who is Other.
 */
export function projectOwnershipHistory(
  histories: readonly NormalizedRepoHistory[],
  identity: HistoryIdentity,
  selection: ReadonlySet<number> | null,
  options: HistoryProjectionOptions = {},
): OwnershipHistorySeries {
  const split = options.split ?? "people";
  const limit = options.limit ?? 8;
  const present = histories.filter((h) => h.days.length > 0);
  if (!present.length || (selection && selection.size === 0)) return { data: [], series: [] };
  let min = Infinity;
  let max = -Infinity;
  for (const h of present) {
    min = Math.min(min, h.days[0]);
    max = Math.max(max, h.days[h.days.length - 1]);
  }
  const dayCount = Math.round((max - min) / DAY) + 1;
  const keyNames: string[] = [];
  const labels: string[] = [];
  const perRepo: Array<{ history: NormalizedRepoHistory; events: Events; include: ((key: number) => boolean) | null }> = [];
  if (split === "people") {
    for (const person of identity.index.people) {
      keyNames.push(person.key);
      labels.push(person.label);
    }
    for (const history of present) {
      perRepo.push({ history, events: personEvents(history, identity), include: selection ? (key) => selection.has(key) : null });
    }
  } else if (split === "repository") {
    present.forEach((history, i) => {
      keyNames.push(`repo:${history.repoId}`);
      labels.push(options.repoNames?.get(history.repoId) ?? `Repository ${history.repoId}`);
      perRepo.push({ history, events: totalEvents(history, identity, selection, i), include: null });
    });
  } else {
    keyNames.push("total");
    labels.push("Lines");
    for (const history of present) perRepo.push({ history, events: totalEvents(history, identity, selection, 0), include: null });
  }

  // Bucket every event by calendar day once; both passes read the same order.
  const counts = new Int32Array(dayCount + 1);
  for (const { history, events, include } of perRepo) {
    for (let i = 0; i < events.length; i++) {
      if (include && !include(events.keys[i])) continue;
      counts[Math.round((history.days[events.days[i]] - min) / DAY) + 1] += 1;
    }
  }
  for (let d = 1; d <= dayCount; d++) counts[d] += counts[d - 1];
  const total = counts[dayCount];
  const eventKeys = new Int32Array(total);
  const eventDeltas = new Float64Array(total);
  const cursor = counts.slice(0, dayCount);
  for (const { history, events, include } of perRepo) {
    for (let i = 0; i < events.length; i++) {
      if (include && !include(events.keys[i])) continue;
      const slot = cursor[Math.round((history.days[events.days[i]] - min) / DAY)]++;
      eventKeys[slot] = events.keys[i];
      eventDeltas[slot] = events.deltas[i];
    }
  }

  const levels = new Float64Array(keyNames.length);
  const peaks = new Float64Array(keyNames.length);
  // Peaks are end-of-day levels: lines moving between repositories within a day
  // must not register as a transient high.
  for (let d = 0, e = 0; d < dayCount; d++) {
    const from = e;
    for (; e < counts[d + 1]; e++) levels[eventKeys[e]] += eventDeltas[e];
    for (let i = from; i < e; i++) {
      const key = eventKeys[i];
      if (levels[key] > peaks[key]) peaks[key] = levels[key];
    }
  }
  const ranked = [...peaks.keys()].filter((k) => peaks[k] > 0)
    .sort((a, b) => peaks[b] - peaks[a] || labels[a].localeCompare(labels[b]));
  const effectiveLimit = split === "total" ? 1 : limit;
  const kept = ranked.slice(0, effectiveLimit);
  const hasRest = ranked.length > kept.length;
  const keptSlot = new Int32Array(keyNames.length).fill(-1);
  kept.forEach((key, slot) => { keptSlot[key] = slot; });
  const series = [
    ...kept.map((key, slot) => ({ key: keyNames[key], label: labels[key], slot })),
    ...(hasRest ? [{ key: "other", label: "Other", slot: null as number | null }] : []),
  ];

  levels.fill(0);
  let everyone = 0;
  let keptSum = 0;
  const data: Array<Record<string, number>> = new Array(dayCount);
  for (let d = 0, e = 0; d < dayCount; d++) {
    for (; e < counts[d + 1]; e++) {
      const key = eventKeys[e];
      const delta = eventDeltas[e];
      levels[key] += delta;
      everyone += delta;
      if (keptSlot[key] >= 0) keptSum += delta;
    }
    const row: Record<string, number> = { week: min + d * DAY };
    for (const key of kept) row[keyNames[key]] = levels[key];
    if (hasRest) row.other = everyone - keptSum;
    data[d] = row;
  }
  return { data, series };
}

/** One-call form for tests and small callers. Selection uses the shared login semantics. */
export function ownershipHistorySeries(
  points: readonly OwnershipHistoryPoint[] | readonly RepoHistoryData[],
  selectedLogins: readonly string[] = [],
  options: HistoryProjectionOptions & { accounts?: OwnershipAccountIndex | ReadonlyMap<string, { login: string; id: string }> } = {},
): OwnershipHistorySeries {
  const data: RepoHistoryData[] = points.length && "identities" in points[0]
    ? points as RepoHistoryData[]
    : [...new Set((points as OwnershipHistoryPoint[]).map((p) => p.repoId))].map((repoId) => legacyHistory(repoId, points as OwnershipHistoryPoint[]));
  const histories = data.map(normalizeRepoHistory);
  const identity = resolveOwnershipPeople(histories, options.accounts);
  return projectOwnershipHistory(histories, identity, selectOwnershipPeople(identity.index, selectedLogins), options);
}

/** How many marks the plot can show usefully at this width. */
export function plotBudget(width: number, shape: "area" | "line" | "bar"): number {
  const px = Math.max(240, width);
  return Math.max(30, Math.floor(px / (shape === "bar" ? 4 : 2)));
}

export interface PlotRows {
  rows: Array<Record<string, number>>;
  /** Rows of the exact period folded into each plotted point. 1 means exact. */
  factor: number;
  /** Plotted point start → last exact period in it, for tooltip headings. */
  ends: ReadonlyMap<number, number>;
}

/**
 * Coarsen only what is painted. Cumulative points keep the level at the end of
 * their bucket; per-period points sum every change in it, so negatives survive.
 * Exact rows stay available for the table, export and lookup.
 */
export function coarsenPlotRows(
  rows: ReadonlyArray<Record<string, number>>,
  keys: readonly string[],
  budget: number,
  reading: OwnershipReading,
): PlotRows {
  const factor = Math.max(1, Math.ceil(rows.length / Math.max(1, budget)));
  if (factor === 1) return { rows: rows as Array<Record<string, number>>, factor, ends: new Map() };
  const out: Array<Record<string, number>> = [];
  const ends = new Map<number, number>();
  for (let start = 0; start < rows.length; start += factor) {
    const end = Math.min(rows.length, start + factor) - 1;
    const row: Record<string, number> = { week: rows[start].week };
    for (const key of keys) {
      if (reading === "cumulative") row[key] = rows[end][key] ?? 0;
      else {
        let sum = 0;
        for (let i = start; i <= end; i++) sum += rows[i][key] ?? 0;
        row[key] = sum;
      }
    }
    ends.set(row.week, rows[end].week);
    out.push(row);
  }
  return { rows: out, factor, ends };
}
