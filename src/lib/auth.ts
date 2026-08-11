import { Command } from "@tauri-apps/plugin-shell";
import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("settings.json");

const TOKEN_KEY = "github_token";
const ORG_KEY = "org";

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

export async function getOrg(): Promise<string | null> {
  return (await store.get<string>(ORG_KEY)) ?? null;
}

export async function setOrg(org: string): Promise<void> {
  await store.set(ORG_KEY, org.trim());
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
