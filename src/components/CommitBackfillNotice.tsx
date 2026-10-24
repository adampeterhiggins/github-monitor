import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApp } from "../lib/state/app";
import { legacyCommitLogRepoIds } from "../lib/db/queries";
import { beginSync, cancelSync, finishSync, runSync } from "../lib/ingest/sync";
import { Button, Callout, full } from "./ui";

/** Refresh older daily log formats without repeating unrelated endpoints. */
export function CommitBackfillNotice({ repoIds }: { repoIds: readonly number[] }) {
  const db = useApp((s) => s.db);
  const token = useApp((s) => s.token);
  const orgs = useApp((s) => s.orgs);
  const syncing = useApp((s) => s.syncing);
  const sync = useApp((s) => s.sync);
  const setSync = useApp((s) => s.setSync);
  const setSyncing = useApp((s) => s.setSyncing);
  const reloadSyncTime = useApp((s) => s.reloadSyncTime);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  const needed = useQuery({
    queryKey: ["commit-backfill", repoIds.join(",")],
    enabled: db != null && repoIds.length > 0,
    queryFn: () => legacyCommitLogRepoIds(db!, repoIds),
  });

  const ids = needed.data ?? [];
  if (needed.isLoading || ids.length === 0) return null;

  const run = async () => {
    if (!db || !token || !orgs.length || syncing) return;
    const controller = beginSync();
    setError(null);
    setStarted(true);
    setSyncing(true);
    try {
      const result = await runSync({
        db,
        token,
        orgs,
        backfillCommits: true,
        // The chart can include an archived repository the bulk sync would skip.
        repoIds: ids,
        includeArchived: true,
        signal: controller.signal,
        onProgress: setSync,
      });
      await reloadSyncTime();
      await queryClient.invalidateQueries();
      if (!result.cancelled && result.errors.length > 0) {
        const first = result.errors.slice(0, 2).map((item) => `${item.repo}: ${item.message}`).join(" ");
        setError(
          `Some repositories did not finish. ${first} Backfill again to continue with the ones still missing.`,
        );
      }
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    } finally {
      finishSync(controller);
      setSyncing(false);
      setStarted(false);
    }
  };

  const subject = ids.length === 1
    ? "This repository’s daily commits"
    : `Daily commits for ${full(ids.length)} repositories`;

  return (
    <div className="mb-3">
      <Callout tone="warning">
        <p>
          {subject} need refreshing to include PR associations. Backfill reads the whole
          default-branch history, including co-authors, so PR commits can be filtered.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={syncing || !token || orgs.length === 0}
            title="Re-read the full default-branch history for just these repositories, including co-authors and PR associations. Nothing else is synced."
            onClick={() => void run()}
          >
            Backfill daily commits
          </Button>
          {syncing && started ? (
            <Button variant="ghost" onClick={cancelSync}>
              Cancel
            </Button>
          ) : null}
        </div>
        {syncing && started && sync ? (
          <p className="mt-1.5 text-[11px] text-ink-muted">
            {sync.label}
            {sync.current ? ` — ${sync.current}` : ""}
            {sync.total > 0 ? ` · ${full(sync.done)} / ${full(sync.total)}` : ""}
          </p>
        ) : null}
        {error ? <p className="mt-1.5 text-[11px] text-ink">{error}</p> : null}
      </Callout>
    </div>
  );
}
