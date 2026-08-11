import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  checkForUpdate,
  currentVersion,
  describeUpdateError,
  initialUpdateState,
  installUpdate,
  restartToApply,
  type UpdateState,
} from "../updates";

/**
 * One shared update store.
 *
 * The sidebar badge and the Settings card both need this, and it must be a single
 * source of truth: two independent checkers would double the network calls and
 * could disagree about whether an update exists.
 *
 * The `Update` handle itself is kept in a module-level ref rather than in the store
 * — it is a live object with methods, not state to render.
 */

let pendingUpdate: Update | null = null;

/** Give a freshly-opened app time to settle before touching the network. */
const STARTUP_DELAY_MS = 15_000;
/** Releases are occasional, so the background cadence is deliberately slow. */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface UpdateStore extends UpdateState {
  /** True while a check or download is in flight, to prevent overlap. */
  busy: boolean;
  pollerStarted: boolean;
  loadVersion: () => Promise<void>;
  check: (manual: boolean) => Promise<void>;
  download: () => Promise<void>;
  restart: () => Promise<void>;
  startPoller: () => () => void;
}

export const useUpdates = create<UpdateStore>((set, get) => ({
  ...initialUpdateState,
  busy: false,
  pollerStarted: false,

  loadVersion: async () => {
    try {
      set({ currentVersion: await currentVersion() });
    } catch {
      // Outside a Tauri window there is no app version; not worth surfacing.
    }
  },

  check: async (manual) => {
    if (get().busy) return;
    // Never interrupt an in-progress download with a background check.
    const phase = get().phase;
    if (phase === "downloading" || phase === "ready" || phase === "installing") return;

    set({ busy: true });
    if (manual) set({ phase: "checking", error: null });

    try {
      const token = readToken();
      const { update, state } = await checkForUpdate(token);
      pendingUpdate = update;
      set(state);
    } catch (err) {
      // A failed background check stays quiet; a failed manual one must be visible.
      if (manual) set({ phase: "error", error: describeUpdateError(err) });
      else set({ error: null });
    } finally {
      set({ busy: false });
    }
  },

  download: async () => {
    if (!pendingUpdate || get().busy) return;
    set({ busy: true });
    try {
      await installUpdate(pendingUpdate, readToken(), (p) => set(p));
    } catch (err) {
      set({ phase: "error", error: describeUpdateError(err) });
    } finally {
      set({ busy: false });
    }
  },

  restart: async () => {
    set({ phase: "installing" });
    try {
      await restartToApply();
    } catch (err) {
      set({ phase: "error", error: describeUpdateError(err) });
    }
  },

  startPoller: () => {
    if (get().pollerStarted) return () => {};
    set({ pollerStarted: true });
    void get().loadVersion();
    const startup = setTimeout(() => void get().check(false), STARTUP_DELAY_MS);
    const poll = setInterval(() => void get().check(false), POLL_INTERVAL_MS);
    return () => {
      clearTimeout(startup);
      clearInterval(poll);
      set({ pollerStarted: false });
    };
  },
}));

/**
 * The GitHub token lives in the app store. Read it lazily at call time rather than
 * wiring a store-to-store subscription, so a token added after launch is picked up.
 */
let tokenGetter: () => string | null = () => null;

export function provideUpdateToken(getter: () => string | null): void {
  tokenGetter = getter;
}

function readToken(): string | null {
  return tokenGetter();
}
