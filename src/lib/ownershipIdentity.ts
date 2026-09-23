import { isBotIdentity } from "./bots";
import { NO_CONTRIBUTORS } from "./contributorSelection";

/**
 * Who a Git author is, for line ownership.
 *
 * A person is one GitHub account whenever GitHub gave us evidence for it: a
 * commits-API match for the email, or a numeric-ID noreply address. The account
 * ID is the key, so a renamed login stays one person. Without that evidence an
 * author is an unmatched Git identity, keyed by email (or by name within one
 * repository when there is no email). A shared display name never joins two
 * people; that is exactly how two real accounts used to become one item.
 *
 * Because every key is derived from the email (or the account it resolves to),
 * joining by "same email or same account" is a lookup rather than a transitive
 * union: two raw identities are the same person exactly when they resolve to the
 * same key.
 */

/** Bumped whenever the rules below change what a raw identity resolves to. */
export const IDENTITY_RULES_VERSION = 2;

/** Selection tokens for unmatched people. They contain a colon, which no GitHub login can. */
export const UNMATCHED_EMAIL = "unmatched-email:";
export const UNMATCHED_NAME = "unmatched-name:";
const GITHUB = "github:";
const GITHUB_LOGIN = "github-login:";

export type PersonKey = string;
export type MatchSource = "github" | "manual" | "unmatched";

export function isUnmatchedToken(token: string): boolean {
  return token.startsWith(UNMATCHED_EMAIL) || token.startsWith(UNMATCHED_NAME);
}

export interface RawIdentity {
  name: string;
  email: string;
  /** Only used to scope an email-less identity to its repository. */
  repoId?: number | null;
}

export interface AccountUser {
  id: string;
  /** The login Contributors shows when known, otherwise the best known login. */
  login: string;
  /** Every login seen for this ID, including the current one. */
  logins: readonly string[];
}

export interface ManualMapping {
  mappingId: number;
  matchKind: "email" | "repo_name";
  /** Normalized email, or normalized Git name for a repository-scoped row. */
  matchValue: string;
  repoId: number | null;
  githubId: string;
  loginAtSave: string;
  reviewedAutoConflict: boolean;
}

/** Everything the resolver knows about GitHub accounts, with one revision for caching. */
export interface OwnershipAccountIndex {
  revision: string;
  /** Unambiguous commit-API matches by normalized email. */
  byEmail: ReadonlyMap<string, { id: string; login: string }>;
  /** Emails with evidence for more than one account. */
  conflicts: ReadonlyMap<string, readonly string[]>;
  users: ReadonlyMap<string, AccountUser>;
  /** Lowercase login to account ID. Current logins win over former ones. */
  loginToId: ReadonlyMap<string, string>;
  manualByEmail: ReadonlyMap<string, ManualMapping>;
  /** Keyed by `${repoId}\0${normalized name}`. */
  manualByRepoName: ReadonlyMap<string, ManualMapping>;
}

export const normalizeEmail = (email: string) => email.trim().replace(/^<|>$/g, "").trim().toLowerCase();
export const normalizeName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** `login@users.noreply…` and `id+login@users.noreply…` are the same account; only the second proves which. */
export function parseNoreply(email: string): { id: string | null; login: string } | null {
  const match = normalizeEmail(email).match(/^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/);
  if (!match?.[2]) return null;
  return { id: match[1] ?? null, login: match[2] };
}

export interface AccountIndexInput {
  revision?: string;
  /** Commits-API matches: email, login, id. Rows with a null id are misses. */
  accounts?: Iterable<readonly [string, { login: string | null; id: string | null }]>;
  /** Every (email, id) GitHub has returned, so a changed answer is a visible conflict. */
  observations?: Iterable<{ email: string; id: string }>;
  /** Registry rows: id with its current login and any former ones. */
  users?: Iterable<{ id: string; login: string; logins?: readonly string[] }>;
  manual?: Iterable<ManualMapping>;
}

export function buildAccountIndex(input: AccountIndexInput = {}): OwnershipAccountIndex {
  const idsByEmail = new Map<string, Map<string, string>>();
  const note = (email: string, id: string, login: string) => {
    const key = normalizeEmail(email);
    if (!key || !id) return;
    const ids = idsByEmail.get(key) ?? new Map<string, string>();
    if (!ids.has(id) || login) ids.set(id, login || ids.get(id) || "");
    idsByEmail.set(key, ids);
  };
  for (const [email, account] of input.accounts ?? []) {
    if (account.id && account.login) note(email, account.id, account.login);
  }
  for (const row of input.observations ?? []) note(row.email, row.id, "");
  const byEmail = new Map<string, { id: string; login: string }>();
  const conflicts = new Map<string, string[]>();
  for (const [email, ids] of idsByEmail) {
    if (ids.size === 1) {
      const [[id, login]] = ids;
      byEmail.set(email, { id, login });
    } else conflicts.set(email, [...ids.keys()].sort());
  }
  const users = new Map<string, AccountUser>();
  const logins = new Map<string, Set<string>>();
  const addLogin = (id: string, login: string) => {
    if (!id || !login) return;
    const set = logins.get(id) ?? new Set<string>();
    set.add(login);
    logins.set(id, set);
  };
  for (const user of input.users ?? []) {
    users.set(user.id, { id: user.id, login: user.login, logins: [] });
    addLogin(user.id, user.login);
    for (const login of user.logins ?? []) addLogin(user.id, login);
  }
  for (const [, ids] of idsByEmail) for (const [id, login] of ids) addLogin(id, login);
  for (const [id, set] of logins) {
    const existing = users.get(id);
    users.set(id, { id, login: existing?.login ?? [...set].sort()[0], logins: [...set].sort() });
  }
  const loginToId = new Map<string, string>();
  for (const user of users.values()) loginToId.set(user.login.toLowerCase(), user.id);
  for (const user of users.values()) for (const login of user.logins) {
    if (!loginToId.has(login.toLowerCase())) loginToId.set(login.toLowerCase(), user.id);
  }
  const manualByEmail = new Map<string, ManualMapping>();
  const manualByRepoName = new Map<string, ManualMapping>();
  for (const row of input.manual ?? []) {
    if (row.matchKind === "email") manualByEmail.set(normalizeEmail(row.matchValue), row);
    else if (row.repoId != null) manualByRepoName.set(`${row.repoId}\0${normalizeName(row.matchValue)}`, row);
  }
  return {
    revision: input.revision ?? "",
    byEmail, conflicts, users, loginToId, manualByEmail, manualByRepoName,
  };
}

export const EMPTY_ACCOUNT_INDEX: OwnershipAccountIndex = buildAccountIndex({ revision: "empty" });

/** Older call sites pass a plain email → account map. */
export function toAccountIndex(
  accounts?: OwnershipAccountIndex | ReadonlyMap<string, { login: string; id: string }>,
): OwnershipAccountIndex {
  if (!accounts) return EMPTY_ACCOUNT_INDEX;
  if ("byEmail" in accounts) return accounts;
  return buildAccountIndex({ revision: "map", accounts: accounts.entries() });
}

/**
 * Add the login each numeric-ID noreply address names, so an ID-less noreply
 * address for the same login joins that account. Known registry logins win;
 * a login two IDs both claim stays ambiguous and joins neither.
 */
export function withNoreplyLogins(index: OwnershipAccountIndex, emails: Iterable<string>): OwnershipAccountIndex {
  const found = new Map<string, Set<string>>();
  for (const email of emails) {
    const parsed = parseNoreply(email);
    if (!parsed?.id) continue;
    const ids = found.get(parsed.login.toLowerCase()) ?? new Set<string>();
    ids.add(parsed.id);
    found.set(parsed.login.toLowerCase(), ids);
  }
  if (!found.size) return index;
  const loginToId = new Map(index.loginToId);
  let changed = false;
  for (const [login, ids] of found) {
    if (ids.size !== 1 || loginToId.has(login)) continue;
    loginToId.set(login, [...ids][0]);
    changed = true;
  }
  return changed ? { ...index, loginToId } : index;
}

export interface Resolution {
  key: PersonKey;
  githubId: string | null;
  /** The login this evidence names, if any. Not necessarily the current login. */
  loginHint: string | null;
  source: MatchSource;
  /** Automatic evidence points at more than one account. */
  conflict: boolean;
  /** A manual row that exists for this identity but lost to automatic evidence. */
  superseded: ManualMapping | null;
  /** The manual row this identity resolved through, if any. */
  manual: ManualMapping | null;
}

export function unmatchedKey(raw: RawIdentity): PersonKey {
  const email = normalizeEmail(raw.email);
  return email ? `${UNMATCHED_EMAIL}${email}` : `${UNMATCHED_NAME}${raw.repoId ?? ""}:${normalizeName(raw.name)}`;
}

/** GitHub evidence first, then a manual row for an otherwise unresolved identity, then unmatched. */
export function resolveIdentity(raw: RawIdentity, index: OwnershipAccountIndex): Resolution {
  const email = normalizeEmail(raw.email);
  const noreply = email ? parseNoreply(email) : null;
  const ids = new Set<string>();
  let loginHint: string | null = null;
  if (noreply?.id) {
    ids.add(noreply.id);
    loginHint = noreply.login;
  }
  const api = email ? index.byEmail.get(email) : undefined;
  if (api) {
    ids.add(api.id);
    loginHint ??= api.login;
  }
  for (const id of (email && index.conflicts.get(email)) || []) ids.add(id);
  const manual = email
    ? index.manualByEmail.get(email) ?? null
    : raw.repoId != null ? index.manualByRepoName.get(`${raw.repoId}\0${normalizeName(raw.name)}`) ?? null : null;
  const base = { conflict: false, superseded: null, manual: null } as const;
  if (ids.size === 1) {
    const [id] = ids;
    return { ...base, key: `${GITHUB}${id}`, githubId: id, loginHint, source: "github", superseded: manual };
  }
  if (ids.size > 1) {
    if (manual?.reviewedAutoConflict) {
      return { ...base, key: `${GITHUB}${manual.githubId}`, githubId: manual.githubId, loginHint: manual.loginAtSave, source: "manual", conflict: true, manual };
    }
    return { ...base, key: unmatchedKey(raw), githubId: null, loginHint: null, source: "unmatched", conflict: true };
  }
  if (noreply) {
    // An ID-less noreply address names a login, not an account. It joins a known
    // account with that login and otherwise stays provisional until an ID is known.
    const id = index.loginToId.get(noreply.login.toLowerCase());
    if (id) return { ...base, key: `${GITHUB}${id}`, githubId: id, loginHint: noreply.login, source: "github" };
    return { ...base, key: `${GITHUB_LOGIN}${noreply.login.toLowerCase()}`, githubId: null, loginHint: noreply.login, source: "github" };
  }
  if (manual) {
    return { ...base, key: `${GITHUB}${manual.githubId}`, githubId: manual.githubId, loginHint: manual.loginAtSave, source: "manual", manual };
  }
  return { ...base, key: unmatchedKey(raw), githubId: null, loginHint: null, source: "unmatched" };
}

export interface ResolvedPerson {
  key: PersonKey;
  githubId: string | null;
  /** Current login for a matched account. */
  login: string | null;
  /** What the selector, table and legend show. */
  label: string;
  matched: boolean;
  /** How the aliases were matched. A person can have both GitHub and manual aliases. */
  sources: MatchSource[];
  conflict: boolean;
  names: string[];
  emails: string[];
  /** Lowercase tokens the shared selection can hold for this person. */
  selectionTokens: string[];
}

interface PersonBuilder {
  resolution: Resolution;
  names: Map<string, number>;
  emails: Map<string, number>;
  loginHints: Map<string, number>;
  sources: Set<MatchSource>;
  conflict: boolean;
}

const weigh = (map: Map<string, number>, value: string, lines: number) => {
  if (value) map.set(value, (map.get(value) ?? 0) + lines);
};
/** Most lines wins, ties by value. `prefer` ranks above lines, e.g. a full name over a handle. */
const heaviest = (map: ReadonlyMap<string, number>, prefer?: (value: string) => boolean): string | null => {
  let best: string | null = null;
  let bestLines = -1;
  let bestPreferred = false;
  for (const [value, lines] of map) {
    const preferred = prefer?.(value) ?? false;
    const better = best == null || (preferred !== bestPreferred ? preferred
      : lines > bestLines || (lines === bestLines && value < best));
    if (better) {
      best = value;
      bestLines = lines;
      bestPreferred = preferred;
    }
  }
  return best;
};

/**
 * Resolves raw identities once and remembers each result. `personOf` returns a
 * small integer so callers can keep dense arrays per person.
 */
export class OwnershipIdentityIndex {
  readonly accounts: OwnershipAccountIndex;
  private readonly interned = new Map<string, number>();
  private readonly byKey = new Map<PersonKey, number>();
  private readonly builders: PersonBuilder[] = [];
  private finished: ResolvedPerson[] | null = null;
  private tokens: Map<string, number> | null = null;

  constructor(accounts: OwnershipAccountIndex = EMPTY_ACCOUNT_INDEX) {
    this.accounts = accounts;
  }

  /** Resolve and intern. `lines` only weighs which name/login labels the person. */
  personOf(raw: RawIdentity, lines = 0): number {
    const email = normalizeEmail(raw.email);
    const tuple = email ? `e\0${email}\0${raw.name}` : `n\0${raw.repoId ?? ""}\0${raw.name}`;
    let person = this.interned.get(tuple);
    if (person == null) {
      const resolution = resolveIdentity(raw, this.accounts);
      person = this.byKey.get(resolution.key);
      if (person == null) {
        person = this.builders.length;
        this.byKey.set(resolution.key, person);
        this.builders.push({
          resolution, names: new Map(), emails: new Map(), loginHints: new Map(), sources: new Set(), conflict: false,
        });
      }
      const builder = this.builders[person];
      builder.sources.add(resolution.source);
      builder.conflict ||= resolution.conflict;
      this.interned.set(tuple, person);
      this.finished = null;
      this.tokens = null;
    }
    const builder = this.builders[person];
    const name = raw.name.trim();
    weigh(builder.names, name, lines);
    if (email) weigh(builder.emails, email, lines);
    const hint = email ? (parseNoreply(email)?.login ?? this.accounts.byEmail.get(email)?.login) : undefined;
    if (hint) weigh(builder.loginHints, hint, lines);
    else if (builder.resolution.source === "manual" && builder.resolution.loginHint) weigh(builder.loginHints, builder.resolution.loginHint, lines);
    return person;
  }

  /** The person a legacy row belongs to. Old rows may already combine several emails. */
  personOfLegacy(names: readonly string[], emails: readonly string[], repoId: number, lines = 0): number {
    const candidates = (emails.length ? emails : [""]).map((email) => ({ email, name: names[0] ?? "" }));
    // Prefer an email with account evidence so a merged legacy row lands on that account.
    const resolved = candidates.map((c) => ({ c, r: resolveIdentity({ ...c, repoId }, this.accounts) }));
    const chosen = resolved.find((x) => x.r.source !== "unmatched") ?? resolved[0];
    const person = this.personOf({ ...chosen.c, repoId }, lines);
    const builder = this.builders[person];
    for (const name of names) if (name.trim() && !builder.names.has(name.trim())) builder.names.set(name.trim(), 0);
    for (const email of emails) {
      const key = normalizeEmail(email);
      if (key && !builder.emails.has(key)) builder.emails.set(key, 0);
    }
    return person;
  }

  get size(): number {
    return this.builders.length;
  }

  get people(): readonly ResolvedPerson[] {
    if (this.finished) return this.finished;
    this.finished = this.builders.map((b) => {
      const { resolution } = b;
      const matched = resolution.source !== "unmatched";
      const id = resolution.githubId;
      const user = id ? this.accounts.users.get(id) : undefined;
      const login = matched ? user?.login ?? heaviest(b.loginHints) ?? resolution.loginHint : null;
      const names = [...b.names.keys()].sort((x, y) => x.localeCompare(y));
      const emails = [...b.emails.keys()].sort();
      const displayName = heaviest(b.names, (n) => n.includes(" ")) ?? emails[0] ?? "Unknown";
      const tokens = new Set<string>();
      if (matched && login) {
        tokens.add(login.toLowerCase());
        for (const former of user?.logins ?? []) tokens.add(former.toLowerCase());
        for (const hint of b.loginHints.keys()) tokens.add(hint.toLowerCase());
      } else tokens.add(resolution.key);
      return {
        key: resolution.key,
        githubId: id,
        login,
        label: matched && login ? login : `${displayName}*`,
        matched: matched && login != null,
        sources: [...b.sources].sort(),
        conflict: b.conflict,
        names,
        emails,
        selectionTokens: [...tokens],
      };
    });
    return this.finished;
  }

  person(index: number): ResolvedPerson {
    return this.people[index];
  }

  /** Current logins claim a token before former ones, so a reused login selects its current owner. */
  personForSelection(token: string): number | null {
    if (!this.tokens) {
      const tokens = new Map<string, number>();
      const people = this.people;
      people.forEach((p, i) => {
        if (p.login) tokens.set(p.login.toLowerCase(), i);
        else tokens.set(p.key, i);
      });
      people.forEach((p, i) => {
        for (const token of p.selectionTokens) if (!tokens.has(token)) tokens.set(token, i);
      });
      this.tokens = tokens;
    }
    const key = isUnmatchedToken(token) ? token : token.toLowerCase();
    return this.tokens.get(key) ?? null;
  }
}

/** Null means everyone. `[NO_CONTRIBUTORS]` and names that are not logins select nobody. */
export function selectOwnershipPeople(
  index: OwnershipIdentityIndex,
  selected: readonly string[],
): ReadonlySet<number> | null {
  if (selected.length === 0) return null;
  const people = new Set<number>();
  for (const token of selected) {
    if (token === NO_CONTRIBUTORS) continue;
    const person = index.personForSelection(token);
    if (person != null) people.add(person);
  }
  return people;
}

export function isBotPerson(person: ResolvedPerson, patterns: readonly string[]): boolean {
  return (person.login != null && isBotIdentity({ name: person.login, email: "" }, patterns))
    || person.names.some((name) => isBotIdentity({ name, email: "" }, patterns))
    || person.emails.some((email) => isBotIdentity({ name: "", email }, patterns));
}
