import { create } from "zustand";
import type Database from "@tauri-apps/plugin-sql";
import { getDb, getMeta } from "../db";
import { listRepos, setRepoSelection, type RepoRow } from "../db/queries";
import {
  getLogin,
  getOrg,
  getToken,
  setLogin as persistLogin,
  setOrg as persistOrg,
  setToken as persistToken,
} from "../auth";
import type { PeriodId } from "../agg/weeks";
import type { ContributionMetric } from "../agg/metrics";
import type { SyncProgress } from "../ingest/sync";
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
  org: string | null;
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
   */
  selectedLogins: string[];

  period: PeriodId;
  customFrom: number | null;
  customTo: number | null;
  metric: ContributionMetric;
  /** User-added patterns for logins to treat as bots, on top of the built-ins. */
  botPatterns: string[];

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
  setOrg: (org: string) => Promise<void>;
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
  org: null,
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

  theme: readStoredTheme(),
  themeId: readStoredThemeId(),
  sync: null,
  syncing: false,
  probeStamp: 0,

  boot: async () => {
    try {
      applyCurrentTheme();
      const db = await getDb();
      const [token, org, login, lastSyncAt] = await Promise.all([
        getToken(),
        getOrg(),
        getLogin(),
        getMeta(db, "last_sync_at"),
      ]);
      set({ db, token, org, login, lastSyncAt, booted: true, bootError: null });
      if (org) await get().refreshRepos();
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

  setOrg: async (org) => {
    await persistOrg(org);
    set({ org: org.trim(), repos: [], selectedRepoIds: [] });
    await get().refreshRepos();
  },

  refreshRepos: async () => {
    const { db, org } = get();
    if (!db || !org) return;
    const repos = await listRepos(db, org);
    set({
      repos,
      selectedRepoIds: repos.filter((r) => r.included === 1).map((r) => r.id),
    });
  },

  setSelectedRepos: async (ids) => {
    const { db, repos } = get();
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
