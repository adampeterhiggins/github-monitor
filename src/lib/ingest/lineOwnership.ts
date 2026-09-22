import type Database from "@tauri-apps/plugin-sql";
import { Channel, invoke } from "@tauri-apps/api/core";
import { knownGithubAccountEmails, clearOwnershipHistory, ownershipCheckpoint, ownershipHistoryCache, ownershipHistoryCovers, ownershipMetadata, touchOwnershipSnapshot, writeGithubAccounts, writeOwnershipHistory, writeOwnershipSnapshot, type OwnershipHistoryBatch } from "../db/lineOwnership";
import { GitHubClient, GitHubError } from "../github/client";
import { githubUserForCommit } from "../lineOwnership";

interface Progress { completed: number; total: number; phase: string }
interface AccountSample { email: string; sha: string; role: string }

interface CommitUser { login?: string | null; id?: number | null }
interface GithubCommit {
  author: CommitUser | null;
  committer: CommitUser | null;
  commit?: { author?: { email?: string | null } | null; committer?: { email?: string | null } | null } | null;
}

/** Ask GitHub which account authored each git email, once per address. */
async function matchGithubAccounts(options: {
  db: Database; fullName: string; jobId: string; full: boolean; client: GitHubClient;
  signal?: AbortSignal; onProgress?: (progress: Progress) => void;
}): Promise<void> {
  const { db, fullName, jobId, full, client, signal } = options;
  const aborted = () => { if (signal?.aborted) throw new DOMException("Aborted", "AbortError"); };
  aborted();
  options.onProgress?.({ completed: 0, total: 0, phase: "Matching GitHub accounts" });
  const samples = await invoke<AccountSample[]>("line_ownership_account_samples", { githubRepo: fullName, jobId });
  aborted();
  const known = full ? new Set<string>() : await knownGithubAccountEmails(db, samples.map((sample) => sample.email));
  const todo = samples.filter((sample) => !known.has(sample.email));
  if (!todo.length) return;
  const [owner, name] = fullName.split("/");
  let completed = 0;
  for (let index = 0; index < todo.length; index += 6) {
    aborted();
    const batch = todo.slice(index, index + 6);
    const rows = await Promise.all(batch.map(async (sample) => {
      const path = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${sample.sha}`;
      try {
        const response = await client.request<GithubCommit>(path, { signal, allowNotFound: true });
        const resolved = githubUserForCommit(response.data, sample);
        if (!resolved.matched) return null;
        return [sample.email, resolved.account?.login ?? null, resolved.account?.id ?? null] as [string, string | null, string | null];
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
        if (error instanceof GitHubError && (error.status === 401 || error.status === 403)) throw error;
        return null;
      }
    }));
    const found = rows.filter((row): row is [string, string | null, string | null] => row != null);
    if (found.length) await writeGithubAccounts(db, found);
    completed += batch.length;
    options.onProgress?.({ completed: 0, total: 0, phase: `Matching GitHub accounts (${completed}/${todo.length})` });
  }
}

export async function syncOwnershipRepo(options: {
  db: Database; repoId: number; fullName: string; token: string; full: boolean; client: GitHubClient;
  signal?: AbortSignal; onProgress?: (progress: Progress) => void;
}): Promise<void> {
  const { db, repoId, fullName, token, full, signal } = options;
  const aborted = () => { if (signal?.aborted) throw new DOMException("Aborted", "AbortError"); };
  aborted();
  const jobId = crypto.randomUUID();
  const metadataJson = full ? null : await ownershipMetadata(db, repoId);
  const parsed = metadataJson ? JSON.parse(metadataJson) : null;
  const metadata = parsed?.version != null && typeof parsed?.revision === "string" && parsed?.options ? parsed : null;
  aborted();
  // Also retry cancellation on progress in case abort arrived before Rust's
  // command began and reset its cancellation flag.
  const cancel = () => { void invoke("cancel_line_ownership", { jobId }).catch(() => {}); };
  const onProgressMessage = (progress: Progress) => { if (signal?.aborted) cancel(); else options.onProgress?.(progress); };
  // Tauri closes a channel when its command returns, so prepare and calculation
  // each need their own channel or file progress never arrives.
  const progressChannel = () => {
    const channel = new Channel<Progress>();
    channel.onmessage = onProgressMessage;
    return channel;
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    aborted();
    const prepared = await invoke<{ revision: string; unchanged: boolean }>("prepare_line_ownership", {
      githubRepo: fullName, jobId, token, metadata, onProgress: progressChannel(),
    });
    aborted();
    await matchGithubAccounts({
      db, fullName, jobId, full, client: options.client, signal, onProgress: options.onProgress,
    });
    aborted();
    const headUnchanged = !full && prepared.unchanged && metadataJson != null && metadata != null
      && await touchOwnershipSnapshot(db, repoId, metadataJson);
    if (headUnchanged) {
      options.onProgress?.({ completed: 0, total: 0, phase: "Ownership unchanged" });
    } else {
      const previousJson = full ? null : await ownershipCheckpoint(db, repoId);
      aborted();
      const snapshot = await invoke<string>("sync_line_ownership", {
        githubRepo: fullName, jobId, revision: prepared.revision, previousJson, onProgress: progressChannel(),
      });
      aborted();
      await writeOwnershipSnapshot(db, repoId, snapshot, full);
    }
    aborted();
    // The current snapshot is already saved. History continues from its own
    // checkpoint, and a full rebuild drops the old points only after that save.
    if (!full && headUnchanged && await ownershipHistoryCovers(db, repoId, prepared.revision)) return;
    if (full) await clearOwnershipHistory(db, repoId);
    for (let step = 0; step < 100_000; step++) {
      aborted();
      const cache = await ownershipHistoryCache(db, repoId);
      const batch = await invoke<OwnershipHistoryBatch>("advance_line_ownership_history", {
        githubRepo: fullName, jobId, revision: prepared.revision, previousJson: cache, onProgress: progressChannel(),
      });
      aborted();
      if (!batch.done && (!batch.checkpoint || batch.points.length === 0)) throw new Error("Ownership history made no progress");
      await writeOwnershipHistory(db, repoId, prepared.revision, batch);
      if (batch.done) return;
    }
    throw new Error("Ownership history did not finish");
  } catch (error) {
    aborted();
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); }
}
