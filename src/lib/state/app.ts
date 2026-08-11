import { create } from "zustand";
import type Database from "@tauri-apps/plugin-sql";
import { getDb, getMeta } from "../db";
import { listRepos, setRepoSelection, type RepoRow } from "../db/queries";
import { getOrg, getToken, setOrg as persistOrg, setToken as persistToken } from "../auth";
import type { PeriodId } from "../agg/weeks";
import type { SyncProgress } from "../ingest/sync";

export type ThemeMode = "system" | "light" | "dark";
export type ContributionMetric = "commits" | "additions" | "deletions";

interface AppState {
  db: Database | null;
  booted: boolean;
  bootError: string | null;

  token: string | null;
  org: string | null;
  lastSyncAt: string | null;

  repos: RepoRow[];
  /** Repo ids the analytics are scoped to. Empty means "nothing selected". */
  selectedRepoIds: number[];

  period: PeriodId;
  customFrom: number | null;
  customTo: number | null;
  metric: ContributionMetric;

  theme: ThemeMode;
  sync: SyncProgress | null;
  syncing: boolean;

  boot: () => Promise<void>;
  setToken: (token: string) => Promise<void>;
  setOrg: (org: string) => Promise<void>;
  refreshRepos: () => Promise<void>;
  setSelectedRepos: (ids: number[]) => Promise<void>;
  toggleRepo: (id: number) => Promise<void>;
  selectAllRepos: (filter?: (r: RepoRow) => boolean) => Promise<void>;
  setPeriod: (period: PeriodId, custom?: { from: number; to: number }) => void;
  setMetric: (metric: ContributionMetric) => void;
  setTheme: (theme: ThemeMode) => void;
  setSync: (progress: SyncProgress | null) => void;
  setSyncing: (syncing: boolean) => void;
  reloadSyncTime: () => Promise<void>;
}

const THEME_KEY = "github-monitor.theme";
const PERIOD_KEY = "github-monitor.period";

function readStoredTheme(): ThemeMode {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

export function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export const useApp = create<AppState>((set, get) => ({
  db: null,
  booted: false,
  bootError: null,

  token: null,
  org: null,
  lastSyncAt: null,

  repos: [],
  selectedRepoIds: [],

  period: (localStorage.getItem(PERIOD_KEY) as PeriodId) || "3m",
  customFrom: null,
  customTo: null,
  metric: "commits",

  theme: readStoredTheme(),
  sync: null,
  syncing: false,

  boot: async () => {
    try {
      applyTheme(get().theme);
      const db = await getDb();
      const [token, org, lastSyncAt] = await Promise.all([
        getToken(),
        getOrg(),
        getMeta(db, "last_sync_at"),
      ]);
      set({ db, token, org, lastSyncAt, booted: true, bootError: null });
      if (org) await get().refreshRepos();
    } catch (err) {
      set({ bootError: (err as Error)?.message ?? String(err), booted: true });
    }
  },

  setToken: async (token) => {
    await persistToken(token);
    set({ token: token.trim() });
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

  setPeriod: (period, custom) => {
    localStorage.setItem(PERIOD_KEY, period);
    set({
      period,
      customFrom: custom?.from ?? null,
      customTo: custom?.to ?? null,
    });
  },

  setMetric: (metric) => set({ metric }),

  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },

  setSync: (sync) => set({ sync }),
  setSyncing: (syncing) => set({ syncing }),

  reloadSyncTime: async () => {
    const db = get().db;
    if (!db) return;
    set({ lastSyncAt: await getMeta(db, "last_sync_at") });
  },
}));
