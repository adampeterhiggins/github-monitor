import { Command } from "@tauri-apps/plugin-shell";
import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("settings.json");

const TOKEN_KEY = "github_token";
/** Pre-multi-organisation builds stored a single login here; read once to migrate. */
const LEGACY_ORG_KEY = "org";
const ORGS_KEY = "orgs";
const LOGIN_KEY = "github_login";

/**
 * Scope names declared in src-tauri/capabilities/default.json. GUI apps launched
 * from Finder inherit a minimal PATH that omits Homebrew, so the absolute paths
 * are tried before the bare `gh`.
 */
const GH_SCOPE_NAMES = [
  "gh-token-homebrew-arm",
  "gh-token-homebrew-intel",
  "gh-token-path",
] as const;

export async function getToken(): Promise<string | null> {
  return (await store.get<string>(TOKEN_KEY)) ?? null;
}

export async function setToken(token: string): Promise<void> {
  await store.set(TOKEN_KEY, token.trim());
  await store.save();
}

export async function clearToken(): Promise<void> {
  await store.delete(TOKEN_KEY);
  await store.save();
}

/**
 * The authenticated user's own login. Persisted so "repositories I've committed in"
 * works without a round trip, and so it survives restarts.
 */
export async function getLogin(): Promise<string | null> {
  return (await store.get<string>(LOGIN_KEY)) ?? null;
}

export async function setLogin(login: string): Promise<void> {
  await store.set(LOGIN_KEY, login.trim());
  await store.save();
}

/** Trimmed, de-duplicated case-insensitively (GitHub logins are), order kept. */
export function normaliseOrgs(orgs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of orgs) {
    const org = raw.trim();
    if (!org || seen.has(org.toLowerCase())) continue;
    seen.add(org.toLowerCase());
    out.push(org);
  }
  return out;
}

/** "a", "a and b", "a, b and c" — for labels naming every organisation in play. */
export function describeOrgs(orgs: readonly string[]): string {
  if (orgs.length <= 1) return orgs[0] ?? "";
  return `${orgs.slice(0, -1).join(", ")} and ${orgs[orgs.length - 1]}`;
}

export async function getOrgs(): Promise<string[]> {
  const stored = await store.get<unknown>(ORGS_KEY);
  if (Array.isArray(stored)) {
    return normaliseOrgs(stored.filter((x): x is string => typeof x === "string"));
  }
  const legacy = await store.get<string>(LEGACY_ORG_KEY);
  return legacy ? normaliseOrgs([legacy]) : [];
}

export async function setOrgs(orgs: readonly string[]): Promise<void> {
  await store.set(ORGS_KEY, normaliseOrgs(orgs));
  await store.delete(LEGACY_ORG_KEY);
  await store.save();
}

/**
 * Lift the token out of an authenticated `gh` CLI so first run needs no PAT.
 * Returns null when gh is absent or not logged in.
 */
export async function importTokenFromGhCli(): Promise<string | null> {
  for (const name of GH_SCOPE_NAMES) {
    try {
      const out = await Command.create(name, ["auth", "token"]).execute();
      const token = out.stdout.trim();
      if (out.code === 0 && token) return token;
    } catch {
      // This candidate path does not exist; try the next.
    }
  }
  return null;
}

export interface TokenScopes {
  login: string;
  scopes: string[];
  /** Endpoints that need more than the token currently carries. */
  missing: string[];
}

const REQUIRED_SCOPES = [
  { scope: "repo", why: "private repository stats and traffic" },
  { scope: "read:org", why: "listing organisation repositories and teams" },
];

/**
 * Confirm the token works and report which capabilities it unlocks. Traffic and
 * Actions data need push access, so a read-only token silently yields 403 on
 * those endpoints — better to say so up front than to render empty charts.
 */
export function summariseScopes(login: string, scopeHeader: string | null): TokenScopes {
  const scopes = (scopeHeader ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = REQUIRED_SCOPES.filter(
    (r) => !scopes.some((s) => s === r.scope || s.startsWith(`${r.scope}:`)),
  ).map((r) => `${r.scope} (${r.why})`);
  return { login, scopes, missing };
}
