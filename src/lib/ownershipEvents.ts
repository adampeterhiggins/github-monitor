/**
 * Durable-write notifications for line ownership. Published only after a write
 * has committed, so a listener can refetch the affected repository instead of
 * polling everything. A cheap revision probe covers anything missed.
 */
export type OwnershipEvent =
  | { kind: "report"; repoId: number; revision: string | null }
  | { kind: "history"; repoId: number; generation: number; done: boolean }
  | { kind: "accounts" }
  | { kind: "mappings" };

type Listener = (event: OwnershipEvent) => void;

const listeners = new Set<Listener>();

export function publishOwnership(event: OwnershipEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A broken listener must not interrupt a sync.
    }
  }
}

export function subscribeOwnership(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const ENGINE_KEY = "github-monitor.ownership.engine";

export type OwnershipEngine = "blame" | "replay";

/**
 * Replay is the default: it matched a full blame on every real repository tried
 * and is several times faster. Blame stays selectable as the reference, and any
 * replayed history that fails verification is rebuilt with blame automatically.
 */
export function ownershipEngine(): OwnershipEngine {
  try {
    return localStorage.getItem(ENGINE_KEY) === "blame" ? "blame" : "replay";
  } catch {
    return "replay";
  }
}

export function setOwnershipEngine(engine: OwnershipEngine): void {
  try {
    localStorage.setItem(ENGINE_KEY, engine);
  } catch {
    // Private mode or blocked storage: the default engine is used.
  }
}
