import { create } from "zustand";
import type Database from "@tauri-apps/plugin-sql";
import { getDb, getMeta } from "../db";
import { listRepos, setRepoSelection, type RepoRow } from "../db/queries";
import {
  getLogin,
  getOrgs,
  getToken,
  normaliseOrgs,
  setLogin as persistLogin,
  setOrgs as persistOrgs,
  setToken as persistToken,
} from "../auth";
import type { PeriodId } from "../agg/weeks";
import type { ContributionMetric } from "../agg/metrics";
import { inventoryOrg, type SyncProgress } from "../ingest/sync";
import { GitHubClient } from "../github/client";
import {
  applyDocumentTheme,
  DEFAULT_THEME_ID,
  getThemeDefinition,
  subscribeToCustomThemes,
} from "../theme/palette";
import { readBotPatterns, writeBotPatterns } from "../bots";

export type ThemeMode = "system" | "light" | "dark";

interface AppState {
  db: Database | null;
  booted: boolean;
  bootError: string | null;

  token: string | null;
  /** Organisations whose repositories are listed and synced, in the order added. */
  orgs: string[];
  /** The authenticated user's own login, for "repositories I've committed in". */
  login: string | null;
  lastSyncAt: string | null;

  repos: RepoRow[];
  /** Repo ids the analytics are scoped to. Empty means "nothing selected". */
  selectedRepoIds: number[];
  /**
   * Contributor logins the analytics are scoped to.
   *
   * Note the deliberate asymmetry with `selectedRepoIds`: empty here means
   * "every contributor", not "none". Repositories are an explicit opt-in list,
   * whereas a contributor filter is a narrowing applied on top — so the default
   * of "no logins chosen" has to mean unfiltered, or every page would start blank.
   * NO_CONTRIBUTORS represents an explicit empty selection after deselection.
   */
  selectedLogins: string[];

  period: PeriodId;
  customFrom: number | null;
  customTo: number | null;
  metric: ContributionMetric;
  /** User-added patterns for logins to treat as bots, on top of the built-ins. */
  botPatterns: string[];
  /** Forks are hidden from repository lists and never enter the selection. */
  excludeForks: boolean;

  theme: ThemeMode;
  /** Named palette. `default` is this app's built-in light/dark tokens. */
  themeId: string;
  sync: SyncProgress | null;
  syncing: boolean;
  /** Bumped after a contributor probe so cached probe reads re-run. */
  probeStamp: number;
  bumpProbeStamp: () => void;

  boot: () => Promise<void>;
  setToken: (token: string) => Promise<void>;
  setLogin: (login: string) => Promise<void>;
  /** Replace the organisation list. Selections in organisations that stay are kept. */
  setOrgs: (orgs: string[]) => Promise<void>;
  addOrg: (org: string) => Promise<void>;
  removeOrg: (org: string) => Promise<void>;
  refreshRepos: () => Promise<void>;
  setSelectedRepos: (ids: number[]) => Promise<void>;
  toggleRepo: (id: number) => Promise<void>;
  selectAllRepos: (filter?: (r: RepoRow) => boolean) => Promise<void>;
  setSelectedLogins: (logins: string[]) => void;
  toggleLogin: (login: string) => void;
  clearLogins: () => void;
  setPeriod: (period: PeriodId, custom?: { from: number; to: number }) => void;
  setMetric: (metric: ContributionMetric) => void;
  setBotPatterns: (patterns: string[]) => void;
  /** Resolves to the number of selected forks it removed. */
  setExcludeForks: (exclude: boolean) => Promise<number>;
  setTheme: (theme: ThemeMode) => void;
  setThemeId: (themeId: string) => void;
  setSync: (progress: SyncProgress | null) => void;
  setSyncing: (syncing: boolean) => void;
  reloadSyncTime: () => Promise<void>;
}

const THEME_KEY = "github-monitor.theme";
const THEME_ID_KEY = "github-monitor.theme-id";
const PERIOD_KEY = "github-monitor.period";
const CUSTOM_RANGE_KEY = "github-monitor.customRange";
const LOGINS_KEY = "github-monitor.logins";
const EXCLUDE_FORKS_KEY = "github-monitor.excludeForks";

function readStoredExcludeForks(): boolean {
  try {
    return localStorage.getItem(EXCLUDE_FORKS_KEY) === "true";
  } catch {
    return false;
  }
}

/** Drop forks from a selection when forks are excluded. */
function withoutForks(ids: number[], repos: RepoRow[], exclude: boolean): number[] {
  if (!exclude) return ids;
  const forks = new Set(repos.filter((r) => r.fork).map((r) => r.id));
  return ids.filter((id) => !forks.has(id));
}

/**
 * The last custom range, kept so a reload does not silently fall back to a
 * preset — `resolvePeriod` reads "custom" with no dates as 90 days, which would
 * quietly show something other than what the label says.
 */
function readStoredCustomRange(): { from: number; to: number } | null {
  try {
    const raw = localStorage.getItem(CUSTOM_RANGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { from?: unknown; to?: unknown }) : null;
    if (typeof parsed?.from !== "number" || typeof parsed?.to !== "number") return null;
    return { from: parsed.from, to: parsed.to };
  } catch {
    return null;
  }
}

function readStoredLogins(): string[] {
  try {
    const raw = localStorage.getItem(LOGINS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** "custom" without a range would resolve to a preset while saying "Custom". */
function readStoredPeriod(): PeriodId {
  const stored = (localStorage.getItem(PERIOD_KEY) as PeriodId) || "3m";
  return stored === "custom" && readStoredCustomRange() == null ? "3m" : stored;
}

function readStoredTheme(): ThemeMode {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

function readStoredThemeId(): string {
  const raw = localStorage.getItem(THEME_ID_KEY);
  if (raw && (raw === DEFAULT_THEME_ID || getThemeDefinition(raw))) return raw;
  return DEFAULT_THEME_ID;
}

function systemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyCurrentTheme(): void {
  const { theme, themeId } = useApp.getState();
  applyDocumentTheme(themeId, theme, systemDark());
}

export function applyTheme(theme: ThemeMode): void {
  applyDocumentTheme(useApp.getState().themeId, theme, systemDark());
}

let themeSyncStarted = false;

/** Keep the document in sync with OS appearance and the theme library. */
export function startThemeSync(): () => void {
  if (themeSyncStarted) return () => {};
  themeSyncStarted = true;
  applyCurrentTheme();
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => applyCurrentTheme();
  media.addEventListener("change", onChange);
  const unsubscribe = subscribeToCustomThemes(() => {
    const { themeId } = useApp.getState();
    if (!getThemeDefinition(themeId)) useApp.getState().setThemeId(DEFAULT_THEME_ID);
    else applyCurrentTheme();
  });
  return () => {
    themeSyncStarted = false;
    media.removeEventListener("change", onChange);
    unsubscribe();
  };
}

export const useApp = create<AppState>((set, get) => ({
  db: null,
  booted: false,
  bootError: null,

  token: null,
  orgs: [],
  login: null,
  lastSyncAt: null,

  repos: [],
  selectedRepoIds: [],
  selectedLogins: readStoredLogins(),

  period: readStoredPeriod(),
  customFrom: readStoredCustomRange()?.from ?? null,
  customTo: readStoredCustomRange()?.to ?? null,
  metric: "commits",
  botPatterns: readBotPatterns(),
  excludeForks: readStoredExcludeForks(),

  theme: readStoredTheme(),
  themeId: readStoredThemeId(),
  sync: null,
  syncing: false,
  probeStamp: 0,

  boot: async () => {
    try {
      applyCurrentTheme();
      const db = await getDb();
      const [token, orgs, login, lastSyncAt] = await Promise.all([
        getToken(),
        getOrgs(),
        getLogin(),
        getMeta(db, "last_sync_at"),
      ]);
      set({ db, token, orgs, login, lastSyncAt, booted: true, bootError: null });
      if (orgs.length) await get().refreshRepos();
    } catch (err) {
      set({ bootError: (err as Error)?.message ?? String(err), booted: true });
    }
  },

  setToken: async (token) => {
    await persistToken(token);
    set({ token: token.trim() });
  },

  setLogin: async (login) => {
    await persistLogin(login);
    set({ login: login.trim() });
  },

  setOrgs: async (requested) => {
    const { db, token } = get();
    const orgs = normaliseOrgs(requested);
    const known = new Set(get().orgs.map((o) => o.toLowerCase()));
    const added = orgs.filter((o) => !known.has(o.toLowerCase()));
    if (db && token && added.length) {
      // Listed before saving, so a mistyped login fails here rather than at the
      // next sync, and the new repositories are selectable straight away.
      const client = new GitHubClient({ token });
      await Promise.all(
        added.map((org) =>
          inventoryOrg(db, client, org).catch((err) => {
            throw new Error(`Could not list repositories for ${org}: ${(err as Error)?.message ?? String(err)}`);
          }),
        ),
      );
    }
    await persistOrgs(orgs);
    set({ orgs });
    if (orgs.length) await get().refreshRepos();
    else set({ repos: [], selectedRepoIds: [] });
  },

  addOrg: async (org) => get().setOrgs([...get().orgs, org]),

  removeOrg: async (org) =>
    get().setOrgs(get().orgs.filter((o) => o.toLowerCase() !== org.trim().toLowerCase())),

  refreshRepos: async () => {
    const { db, orgs } = get();
    if (!db || !orgs.length) return;
    const repos = await listRepos(db, orgs);
    set({
      repos,
      selectedRepoIds: withoutForks(repos.filter((r) => r.included === 1).map((r) => r.id), repos, get().excludeForks),
    });
  },

  setSelectedRepos: async (requested) => {
    const { db, repos, excludeForks } = get();
    const ids = withoutForks(requested, repos, excludeForks);
    set({ selectedRepoIds: ids });
    if (!db) return;
    const wanted = new Set(ids);
    await setRepoSelection(
      db,
      repos.map((r) => ({ repoId: r.id, included: wanted.has(r.id) })),
    );
  },

  toggleRepo: async (id) => {
    const current = get().selectedRepoIds;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    await get().setSelectedRepos(next);
  },

  setExcludeForks: async (exclude) => {
    try {
      localStorage.setItem(EXCLUDE_FORKS_KEY, String(exclude));
    } catch {
      // Blocked storage: the choice lasts for this session.
    }
    set({ excludeForks: exclude });
    const before = get().selectedRepoIds;
    if (!exclude) return 0;
    await get().setSelectedRepos(before);
    return before.length - get().selectedRepoIds.length;
  },

  selectAllRepos: async (filter) => {
    const repos = get().repos;
    const ids = (filter ? repos.filter(filter) : repos).map((r) => r.id);
    await get().setSelectedRepos(ids);
  },

  setSelectedLogins: (logins) => {
    const unique = [...new Set(logins)];
    localStorage.setItem(LOGINS_KEY, JSON.stringify(unique));
    set({ selectedLogins: unique });
  },

  toggleLogin: (login) => {
    const current = get().selectedLogins;
    const next = current.includes(login)
      ? current.filter((l) => l !== login)
      : [...current, login];
    get().setSelectedLogins(next);
  },

  clearLogins: () => get().setSelectedLogins([]),

  setPeriod: (period, custom) => {
    localStorage.setItem(PERIOD_KEY, period);
    if (custom) localStorage.setItem(CUSTOM_RANGE_KEY, JSON.stringify(custom));
    set({
      period,
      // Held on to when a preset is picked, so going back to a custom range does
      // not mean typing the dates again. Only `period === "custom"` reads them.
      customFrom: custom?.from ?? get().customFrom,
      customTo: custom?.to ?? get().customTo,
    });
  },

  setMetric: (metric) => set({ metric }),

  setBotPatterns: (patterns) => {
    const cleaned = [...new Set(patterns.map((p) => p.trim()).filter(Boolean))];
    writeBotPatterns(cleaned);
    set({ botPatterns: cleaned });
  },

  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
    applyCurrentTheme();
  },

  setThemeId: (themeId) => {
    localStorage.setItem(THEME_ID_KEY, themeId);
    set({ themeId });
    applyCurrentTheme();
  },

  setSync: (sync) => set({ sync }),
  setSyncing: (syncing) => set({ syncing }),
  bumpProbeStamp: () => set({ probeStamp: get().probeStamp + 1 }),

  reloadSyncTime: async () => {
    const db = get().db;
    if (!db) return;
    set({ lastSyncAt: await getMeta(db, "last_sync_at") });
  },
}));
