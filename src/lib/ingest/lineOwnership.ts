import type Database from "@tauri-apps/plugin-sql";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  beginHistoryGeneration, failHistoryGeneration, historyGenState, HISTORY_FORMAT, knownGithubAccountEmails,
  markGithubUserChecked, ownershipCheckpoint, ownershipHistoryCovers, ownershipMetadata, ownershipReport,
  reopenHistoryGeneration, staleGithubUsers, touchOwnershipSnapshot, writeGithubAccounts, writeGithubUserLookup,
  writeHistoryBatch, writeOwnershipSnapshot, type HistoryBatchV2, type OwnershipScan,
} from "../db/lineOwnership";
import { getMeta, setMeta } from "../db";
import { GitHubClient, GitHubError } from "../github/client";
import { githubUserForCommit, type OwnershipReport } from "../lineOwnership";
import { ownershipEngine, publishOwnership, type OwnershipEngine } from "../ownershipEvents";

interface Progress { completed: number; total: number; phase: string }
interface AccountSample { email: string; sha: string; role: string }

interface CommitUser { login?: string | null; id?: number | null }
interface GithubCommit {
  author: CommitUser | null;
  committer: CommitUser | null;
  commit?: { author?: { email?: string | null } | null; committer?: { email?: string | null } | null } | null;
}

const DAY_MS = 86_400_000;
/** A miss is asked about again after this long; GitHub may have linked the email since. */
const RETRY_MISSES_AFTER = 30 * DAY_MS;
/** A login read back by ID is refreshed after this long, to catch renames. */
const REFRESH_LOGINS_AFTER = 30 * DAY_MS;

const isAbort = (error: unknown, signal?: AbortSignal) =>
  signal?.aborted || (error instanceof DOMException && error.name === "AbortError");

type AccountRow = [string, string | null, string | null];

interface CommitAuthors {
  authors?: { nodes?: Array<{ email?: string | null; user?: { login: string; databaseId: number } | null } | null> } | null;
}

/**
 * Accounts for co-author samples, from GitHub's own author list for each commit
 * (which includes `Co-authored-by` trailers). A listed email with no user is a
 * miss; a commit or email GitHub did not return is left for the next sync.
 */
export function coauthorAccounts(
  samples: readonly AccountSample[],
  commits: ReadonlyArray<CommitAuthors | null | undefined>,
): AccountRow[] {
  const rows: AccountRow[] = [];
  samples.forEach((sample, i) => {
    const nodes = commits[i]?.authors?.nodes;
    if (!nodes) return;
    const node = nodes.find((n) => n?.email?.trim().toLowerCase() === sample.email);
    if (!node) return;
    rows.push(node.user ? [sample.email, node.user.login, String(node.user.databaseId)] : [sample.email, null, null]);
  });
  return rows;
}

async function lookupCoauthors(
  client: GitHubClient, owner: string, name: string, samples: readonly AccountSample[], signal?: AbortSignal,
): Promise<AccountRow[]> {
  const valid = samples.filter((s) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s.sha));
  if (!valid.length) return [];
  const fields = valid.map((s, i) => `c${i}: object(oid: "${s.sha}") { ... on Commit { authors(first: 50) { nodes { email user { login databaseId } } } } }`);
  const data = await client.graphql<{ repository: Record<string, CommitAuthors | null> | null }>(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`,
    { owner, name }, { signal },
  );
  return coauthorAccounts(valid, valid.map((_, i) => data.repository?.[`c${i}`]));
}

/** Ask GitHub which account authored each git email. New emails always; old misses a few at a time. */
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
  const emails = samples.map((sample) => sample.email);
  const known = full ? new Set<string>() : await knownGithubAccountEmails(db, emails);
  const settled = full ? new Set<string>() : await knownGithubAccountEmails(db, emails, new Date(Date.now() - RETRY_MISSES_AFTER).toISOString());
  const fresh = samples.filter((sample) => !known.has(sample.email));
  const retries = samples.filter((sample) => known.has(sample.email) && !settled.has(sample.email)).slice(0, 25);
  const todo = [...fresh, ...retries];
  if (!todo.length) return;
  const [owner, name] = fullName.split("/");
  const coauthors = todo.filter((sample) => sample.role === "coauthor");
  const direct = todo.filter((sample) => sample.role !== "coauthor");
  let completed = 0;
  // Co-authors resolve through GraphQL, many commits per request.
  for (let index = 0; index < coauthors.length; index += 25) {
    aborted();
    const batch = coauthors.slice(index, index + 25);
    let found: AccountRow[] = [];
    try {
      found = await lookupCoauthors(client, owner, name, batch, signal);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      if (error instanceof GitHubError && (error.status === 401 || error.status === 403)) throw error;
    }
    if (found.length) {
      await writeGithubAccounts(db, found);
      publishOwnership({ kind: "accounts" });
    }
    completed += batch.length;
    options.onProgress?.({ completed: 0, total: 0, phase: `Matching GitHub accounts (${completed}/${todo.length})` });
  }
  for (let index = 0; index < direct.length; index += 6) {
    aborted();
    const batch = direct.slice(index, index + 6);
    const rows = await Promise.all(batch.map(async (sample) => {
      const path = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${sample.sha}`;
      try {
        const response = await client.request<GithubCommit>(path, { signal, allowNotFound: true });
        const resolved = githubUserForCommit(response.data, sample);
        if (!resolved.matched) return null;
        return [sample.email, resolved.account?.login ?? null, resolved.account?.id ?? null] as [string, string | null, string | null];
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        if (error instanceof GitHubError && (error.status === 401 || error.status === 403)) throw error;
        return null;
      }
    }));
    const found = rows.filter((row): row is [string, string | null, string | null] => row != null);
    if (found.length) {
      await writeGithubAccounts(db, found);
      publishOwnership({ kind: "accounts" });
    }
    completed += batch.length;
    options.onProgress?.({ completed: 0, total: 0, phase: `Matching GitHub accounts (${completed}/${todo.length})` });
  }
}

/**
 * Read a few accounts back by immutable ID so a renamed login shows as it does on
 * GitHub. Best effort: a rate limit or network failure keeps the last known login
 * and never stops the Git history sync.
 */
export async function refreshGithubLogins(db: Database, client: GitHubClient, signal?: AbortSignal, limit = 10): Promise<number> {
  const ids = await staleGithubUsers(db, new Date(Date.now() - REFRESH_LOGINS_AFTER).toISOString(), limit);
  let changed = 0;
  for (const id of ids) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const response = await client.request<{ id: number; login: string } | null>(`user/${encodeURIComponent(id)}`, { signal, allowNotFound: true });
      if (response.data?.login && String(response.data.id) === id) {
        await writeGithubUserLookup(db, id, response.data.login);
        changed++;
      } else await markGithubUserChecked(db, id);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return changed;
    }
  }
  if (changed) publishOwnership({ kind: "accounts" });
  return changed;
}

/** Credits as `name\0email` sets per line group, comparable across the HEAD scan and the history walk. */
function creditSets(groups: Iterable<[Array<[string, string]>, number]>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [people, lines] of groups) {
    const key = [...new Set(people.map(([name, email]) => `${name}\0${email}`))].sort().join("\u0001");
    out.set(key, (out.get(key) ?? 0) + lines);
  }
  return out;
}

/** The finished walk must end exactly where the HEAD scan (the blame oracle) does. */
export function verifyHistoryFinal(final: HistoryBatchV2["final"], report: OwnershipReport | null): string | null {
  if (!final) return "The history walk returned no final state";
  if (!report) return "No HEAD scan to verify the history against";
  if (final.totalLines !== report.totalLines) return `History ends with ${final.totalLines} lines but the HEAD scan has ${report.totalLines}`;
  const walked = creditSets(final.groups);
  const scanned = creditSets(report.credits.map((c) => [c.people.map((p) => [p.name, p.email] as [string, string]), c.lines]));
  if (walked.size !== scanned.size) return "History attribution does not match the HEAD scan";
  for (const [key, lines] of scanned) if (walked.get(key) !== lines) return "History attribution does not match the HEAD scan";
  return null;
}

const replayMismatchKey = (repoId: number) => `ownership_replay_mismatch:${repoId}`;

export async function syncOwnershipRepo(options: {
  db: Database; repoId: number; fullName: string; token: string; full: boolean; client: GitHubClient;
  engine?: OwnershipEngine; signal?: AbortSignal; onProgress?: (progress: Progress) => void;
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
  // Tauri closes a channel when its command returns, so every command needs its own.
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
    await refreshGithubLogins(db, options.client, signal).catch((error) => { if (isAbort(error, signal)) throw error; });
    aborted();
    const checkpoint = full ? null : await ownershipCheckpoint(db, repoId);
    // A legacy full-JSON snapshot converts on its next sync even if HEAD is unchanged.
    const headUnchanged = !full && prepared.unchanged && metadataJson != null && metadata != null
      && checkpoint?.cacheRef != null && await touchOwnershipSnapshot(db, repoId, metadataJson);
    if (headUnchanged) {
      options.onProgress?.({ completed: 0, total: 0, phase: "Ownership unchanged" });
    } else {
      aborted();
      const scan = await invoke<OwnershipScan>("sync_line_ownership", {
        githubRepo: fullName, jobId, revision: prepared.revision,
        previousRef: checkpoint?.cacheRef ?? null, previousJson: checkpoint?.legacyJson ?? null,
        onProgress: progressChannel(),
      });
      aborted();
      await writeOwnershipSnapshot(db, repoId, scan, full);
      publishOwnership({ kind: "report", repoId, revision: prepared.revision || null });
    }
    aborted();
    // The current snapshot is already saved. History continues from its own
    // checkpoint; a rebuild keeps the previous generation visible until it completes.
    if (!full && headUnchanged && await ownershipHistoryCovers(db, repoId, prepared.revision)) return;
    if (full) await setMeta(db, replayMismatchKey(repoId), "");
    const requested = options.engine ?? ownershipEngine();
    const engine: OwnershipEngine = requested === "replay" && await getMeta(db, replayMismatchKey(repoId)) ? "blame" : requested;
    await advanceHistory({ db, repoId, fullName, jobId, target: prepared.revision, full, engine, aborted, progressChannel, onProgress: options.onProgress });
  } catch (error) {
    aborted();
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); }
}

async function advanceHistory(options: {
  db: Database; repoId: number; fullName: string; jobId: string; target: string; full: boolean; engine: OwnershipEngine;
  aborted: () => void; progressChannel: () => Channel<Progress>; onProgress?: (progress: Progress) => void;
}): Promise<void> {
  const { db, repoId, fullName, jobId, target, aborted, progressChannel } = options;
  let engine = options.engine;
  const state = await historyGenState(db, repoId);
  let generation: number;
  let checkpointRef: string | null;
  const compatible = state != null && state.format === HISTORY_FORMAT && state.engine === engine && !options.full;
  if (compatible && state.status === "building") {
    generation = state.buildingGeneration;
    checkpointRef = state.checkpointRef;
  } else if (compatible && state.status === "done" && state.visibleGeneration === state.buildingGeneration) {
    generation = state.buildingGeneration;
    checkpointRef = state.checkpointRef;
    await reopenHistoryGeneration(db, repoId, generation);
  } else {
    generation = await beginHistoryGeneration(db, repoId, engine);
    checkpointRef = null;
  }
  let resets = 0;
  let completed = -1;
  for (let step = 0; step < 100_000; step++) {
    aborted();
    const batch = await invoke<HistoryBatchV2>("advance_line_ownership_history", {
      githubRepo: fullName, jobId, revision: target, generation, checkpointRef, engine, onProgress: progressChannel(),
    });
    aborted();
    if (batch.needsReset) {
      if (++resets > 2) throw new Error("Ownership history could not restart");
      generation = await beginHistoryGeneration(db, repoId, engine);
      checkpointRef = null;
      completed = -1;
      continue;
    }
    if (!batch.done && batch.completed <= completed) throw new Error("Ownership history made no progress");
    completed = batch.completed;
    let completion: { verified: boolean; error?: string } | null = null;
    if (batch.done) {
      const problem = verifyHistoryFinal(batch.final, await ownershipReport(db, repoId));
      completion = problem ? { verified: false, error: problem } : { verified: true };
    }
    const written = await writeHistoryBatch(db, repoId, generation, target, batch, completion);
    if (!written) throw new Error("Ownership history was restarted by another sync");
    publishOwnership({ kind: "history", repoId, generation, done: batch.done && completion?.verified === true });
    options.onProgress?.({ completed: batch.completed, total: batch.total, phase: `Ownership history ${batch.completed}/${batch.total}` });
    if (!batch.done) {
      checkpointRef = batch.checkpointRef;
      continue;
    }
    if (completion?.verified) return;
    if (engine === "replay") {
      // Blame is the oracle: rebuild this repository with it and stop using replay here.
      await setMeta(db, replayMismatchKey(repoId), target);
      engine = "blame";
      generation = await beginHistoryGeneration(db, repoId, engine);
      checkpointRef = null;
      completed = -1;
      continue;
    }
    await failHistoryGeneration(db, repoId, generation, completion?.error ?? "Ownership history failed verification");
    throw new Error(completion?.error ?? "Ownership history failed verification");
  }
  throw new Error("Ownership history did not finish");
}
