import type Database from "@tauri-apps/plugin-sql";
import { Channel, invoke } from "@tauri-apps/api/core";
import { ownershipCheckpoint, writeOwnershipSnapshot } from "../db/lineOwnership";

interface Progress { completed: number; total: number; phase: string }
export async function syncOwnershipRepo(options: {
  db: Database; repoId: number; fullName: string; token: string; full: boolean;
  signal?: AbortSignal; onProgress?: (progress: Progress) => void;
}): Promise<void> {
  const { db, repoId, fullName, token, full, signal } = options;
  const aborted = () => { if (signal?.aborted) throw new DOMException("Aborted", "AbortError"); };
  aborted();
  const previousJson = full ? null : await ownershipCheckpoint(db, repoId);
  aborted();
  const onProgress = new Channel<Progress>();
  // Also retry cancellation on progress in case abort arrived before Rust's
  // command began and reset its cancellation flag.
  const cancel = () => { void invoke("cancel_line_ownership").catch(() => {}); };
  onProgress.onmessage = (progress) => { if (signal?.aborted) cancel(); else options.onProgress?.(progress); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    aborted();
    const snapshot = await invoke<string>("sync_line_ownership", { githubRepo: fullName, token, previousJson, full, onProgress });
    aborted();
    await writeOwnershipSnapshot(db, repoId, snapshot, full);
  } catch (error) {
    aborted();
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); }
}
