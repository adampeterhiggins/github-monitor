import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApp } from "../lib/state/app";
import {
  ALL_ENDPOINTS,
  ENDPOINT_LABELS,
  runSync,
  type EndpointId,
  type SyncError,
  type SyncMode,
} from "../lib/ingest/sync";
import { outstandingWork } from "../lib/db/queries";
import { describeOrgs } from "../lib/auth";
import { Button, Callout, Card, CardHeader, Checkbox, DataTable, Spinner, full } from "./ui";

const ENDPOINT_KEY = "github-monitor.syncEndpoints";
const ARCHIVED_KEY = "github-monitor.syncIncludeArchived";

/** Survives leaving the Sync page. A missing key means every dimension. */
function storedEndpoints(): EndpointId[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ENDPOINT_KEY) ?? "");
    if (!Array.isArray(parsed)) return [...ALL_ENDPOINTS];
    return ALL_ENDPOINTS.filter((id) => parsed.includes(id));
  } catch {
    return [...ALL_ENDPOINTS];
  }
}

/**
 * Sync control. The progress detail matters more here than in a typical app: the
 * `stats/*` endpoints are computed lazily by GitHub and answer 202 while cold, so
 * a first sync legitimately takes minutes and parks on "waiting for GitHub". Without
 * a visible warm/collect breakdown that looks like a hang.
 */
export function SyncPanel({ compact: compactView = false }: { compact?: boolean }) {
  const { db, token, orgs, sync, syncing, setSync, setSyncing, reloadSyncTime, refreshRepos } = useApp();
  const abortRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();
  const [selectedEndpoints, setSelectedEndpoints] = useState<EndpointId[]>(storedEndpoints);
  const [includeArchived, setIncludeArchived] = useState(() => localStorage.getItem(ARCHIVED_KEY) === "true");
  const [fatal, setFatal] = useState<string | null>(null);

  const repos = useApp((s) => s.repos);
  const selectedRepoIds = useApp((s) => s.selectedRepoIds);
  const archivedCount = useMemo(() => repos.filter((r) => r.archived).length, [repos]);

  // Resume counts must match what this run will actually fetch. The bulk sync
  // skips archived repositories unless the user opts them in, so leave them out
  // of the outstanding total when the box is unchecked.
  const workRepoIds = useMemo(() => {
    if (includeArchived) return selectedRepoIds;
    const archived = new Set(repos.filter((r) => r.archived).map((r) => r.id));
    return selectedRepoIds.filter((id) => !archived.has(id));
  }, [selectedRepoIds, repos, includeArchived]);

  // What a resume would actually do, so the offer can be specific rather than
  // asking the user to run a sync to find out.
  const work = useQuery({
    queryKey: ["outstanding-work", workRepoIds.join(","), selectedEndpoints.join(","), syncing],
    enabled: db != null && workRepoIds.length > 0,
    queryFn: () => outstandingWork(db!, workRepoIds, selectedEndpoints),
    staleTime: 5_000,
  });

  const start = useCallback(async (mode: SyncMode) => {
    if (!db || !token || !orgs.length) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setFatal(null);
    setSyncing(true);
    try {
      await runSync({
        db,
        token,
        orgs,
        mode,
        endpoints: selectedEndpoints,
        repoIds: selectedRepoIds,
        includeArchived,
        signal: controller.signal,
        onProgress: setSync,
      });
      await refreshRepos();
      await reloadSyncTime();
      // Every page reads from SQLite, so invalidating clears all of them at once.
      await queryClient.invalidateQueries();
      await work.refetch();
    } catch (err) {
      setFatal((err as Error)?.message ?? String(err));
    } finally {
      setSyncing(false);
      abortRef.current = null;
    }
  }, [db, token, orgs, selectedEndpoints, selectedRepoIds, includeArchived, setSync, setSyncing, refreshRepos, reloadSyncTime, queryClient, work]);

  const cancel = () => abortRef.current?.abort();

  const applyEndpoints = (ids: EndpointId[]) => {
    localStorage.setItem(ENDPOINT_KEY, JSON.stringify(ids));
    setSelectedEndpoints(ids);
  };
  const applyArchived = (value: boolean) => {
    localStorage.setItem(ARCHIVED_KEY, String(value));
    setIncludeArchived(value);
  };
  const canSync = Boolean(db && token && orgs.length && selectedRepoIds.length > 0 && selectedEndpoints.length > 0);

  const grouped = useMemo(() => groupErrors(sync?.errors ?? []), [sync?.errors]);

  const pct = sync && sync.total > 0 ? Math.round((sync.done / sync.total) * 100) : 0;
  const recorded = work.data
    ? work.data.complete + work.data.pending + work.data.errored
    : 0;

  return (
    <Card>
      <CardHeader
        title="Sync"
        subtitle={
          orgs.length ? `Pulling analytics for ${describeOrgs(orgs)} into the local cache` : "Choose an organisation first"
        }
        actions={
          syncing ? (
            <Button variant="danger" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <>
              {work.data?.resumable ? (
                <Button
                  variant="primary"
                  onClick={() => void start("resume")}
                  disabled={!canSync}
                  title={`Fetch only the ${full(work.data.outstanding)} outstanding items, keeping the ${full(work.data.complete)} already done`}
                >
                  Resume ({full(work.data.outstanding)})
                </Button>
              ) : null}
              <Button
                variant={work.data?.resumable ? "default" : "primary"}
                onClick={() => void start("incremental")}
                disabled={!canSync}
                title="Fetch changes since each endpoint last synced"
              >
                {recorded > 0 ? "Sync changes" : "Sync now"}
              </Button>
              {recorded > 0 ? (
                <Button
                  variant="default"
                  onClick={() => void start("full")}
                  disabled={!canSync}
                  title="Ignore checkpoints and re-fetch every selected endpoint"
                >
                  Full re-sync
                </Button>
              ) : null}
            </>
          )
        }
      />

      {fatal ? (
        <div className="mb-3">
          <Callout tone="critical">{fatal}</Callout>
        </div>
      ) : null}

      {syncing || sync ? (
        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between gap-3 text-[12px]">
            <span className="flex items-center gap-2 text-ink">
              {syncing ? <Spinner /> : null}
              {sync?.label ?? "Starting…"}
            </span>
            <span className="tabular text-ink-secondary">
              {sync ? `${full(sync.done)} / ${full(sync.total)}` : ""}
              {sync && sync.skipped > 0 ? (
                <span className="text-ink-muted"> · {full(sync.skipped)} skipped</span>
              ) : null}
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full"
            style={{ background: "var(--wash-strong)" }}
          >
            <div
              className="h-full rounded-full transition-[width]"
              style={{ width: `${pct}%`, background: "var(--accent)" }}
            />
          </div>
          {sync?.current ? (
            <p className="mt-1.5 truncate text-[11px] text-ink-muted">{sync.current}</p>
          ) : null}
          {sync?.rateLimit ? (
            <p className="mt-1 text-[11px] tabular text-ink-muted">
              API budget: {full(sync.rateLimit.remaining)} / {full(sync.rateLimit.limit)} remaining
            </p>
          ) : null}
        </div>
      ) : null}

      {!syncing && work.data && work.data.resumable ? (
        <div className="mb-3">
          <Callout>
            <strong className="text-ink">{full(work.data.complete)}</strong> of{" "}
            <strong className="text-ink">{full(work.data.complete + work.data.outstanding)}</strong>{" "}
            items are already synced. <strong className="text-ink">Resume</strong> fetches only the{" "}
            <strong className="text-ink">{full(work.data.outstanding)}</strong> outstanding —
            {work.data.pending > 0 ? ` ${full(work.data.pending)} unfinished or still computing,` : ""}
            {work.data.errored > 0 ? ` ${full(work.data.errored)} that failed,` : ""}
            {work.data.never > 0 ? ` ${full(work.data.never)} not yet attempted,` : ""} and leaves the
            rest alone. <strong className="text-ink">Sync changes</strong> also refreshes data that
            changed since its last successful fetch. A full re-sync repeats everything.
          </Callout>
        </div>
      ) : null}

      {!syncing && work.data && !work.data.resumable && work.data.complete > 0 ? (
        <p className="mb-3 text-[12px] text-ink-secondary">
          All {full(work.data.complete)} items are synced for the current selection. Sync changes
          uses their individual checkpoints; full re-sync ignores them.
        </p>
      ) : null}

      {sync?.phase === "warming" ? (
        <Callout>
          GitHub computes contributor and commit statistics on demand. This pass asks for all
          repositories at once so GitHub builds them in parallel — the next pass collects the
          results.
        </Callout>
      ) : null}

      {!compactView ? (
        <>
          <div className="mt-3 border-t border-hairline pt-3">
            <p className="mb-2 text-[12px] font-medium text-ink">What to sync</p>
            <div className="mb-3">
              <Checkbox
                checked={includeArchived}
                disabled={syncing}
                onChange={applyArchived}
                label={
                  <span className="text-ink-secondary">
                    Include archived
                    {archivedCount > 0 ? ` (${full(archivedCount)})` : ""}
                  </span>
                }
              />
              <p className="mt-1 ml-[22px] text-[11px] leading-relaxed text-ink-muted">
                A bulk sync skips archived repositories to save API quota. Turn this on to
                resume or re-sync them in the same run.
              </p>
            </div>
            <p className="mb-3 text-[11px] leading-relaxed text-ink-muted">
              Line ownership saves each repository’s commit and surviving-line attribution.
              The first sync downloads full Git history; later syncs fetch new history and
              recalculate touched files. Full re-sync rebuilds the ownership snapshots.
              Later syncs also record each default-branch commit so ownership can be graphed
              over time. A full re-sync rebuilds that history.
            </p>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Button variant="ghost" disabled={syncing} onClick={() => applyEndpoints([...ALL_ENDPOINTS])}>
                Select all
              </Button>
              <Button variant="ghost" disabled={syncing} onClick={() => applyEndpoints([])}>
                Clear
              </Button>
              <span className="ml-auto text-[11px] tabular text-ink-muted">
                {full(selectedEndpoints.length)} of {full(ALL_ENDPOINTS.length)} selected
              </span>
            </div>
            {selectedEndpoints.length === 0 ? (
              <p className="mb-2 text-[11px] text-ink-muted">Select at least one kind of data to sync.</p>
            ) : null}
            <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              {ALL_ENDPOINTS.map((endpoint) => (
                <div key={endpoint} className="flex items-center gap-1 py-[3px]">
                  <div className="min-w-0 flex-1">
                    <Checkbox
                      checked={selectedEndpoints.includes(endpoint)}
                      disabled={syncing}
                      onChange={(checked) =>
                        applyEndpoints(
                          checked
                            ? ALL_ENDPOINTS.filter((id) => id === endpoint || selectedEndpoints.includes(id))
                            : selectedEndpoints.filter((id) => id !== endpoint),
                        )
                      }
                      label={ENDPOINT_LABELS[endpoint]}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    disabled={syncing}
                    title={`Sync only ${ENDPOINT_LABELS[endpoint]}`}
                    onClick={() => applyEndpoints([endpoint])}
                  >
                    Only
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {grouped.length > 0 ? (
            <div className="mt-3 border-t border-hairline pt-3">
              <p className="mb-2 text-[12px] font-medium text-ink">
                Skipped or incomplete ({full(sync?.errors.length ?? 0)})
              </p>
              <DataTable
                rows={grouped}
                maxHeight={220}
                rowKey={(r) => `${r.endpoint}:${r.kind}`}
                columns={[
                  {
                    key: "endpoint",
                    header: "Data",
                    render: (r) => ENDPOINT_LABELS[r.endpoint] ?? r.endpoint,
                  },
                  { key: "reason", header: "Reason", render: (r) => r.message },
                  {
                    key: "count",
                    header: "Repos",
                    align: "right",
                    render: (r) => full(r.repos.length),
                  },
                  {
                    key: "examples",
                    header: "Examples",
                    render: (r) => (
                      <span className="text-ink-secondary">
                        {r.repos.slice(0, 3).join(", ")}
                        {r.repos.length > 3 ? ` +${r.repos.length - 3}` : ""}
                      </span>
                    ),
                  },
                ]}
              />
              <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
                “Still computing” is normal on a first sync — GitHub keeps building those
                statistics in the background, so running sync again usually picks them up.
                “No access” means the token lacks push permission, which GitHub requires for
                traffic data.
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

interface GroupedError {
  endpoint: EndpointId;
  kind: SyncError["kind"];
  message: string;
  repos: string[];
}

/** One row per (endpoint, failure kind) — 60 identical rows is not a report. */
function groupErrors(errors: SyncError[]): GroupedError[] {
  const map = new Map<string, GroupedError>();
  for (const e of errors) {
    const key = `${e.endpoint}:${e.kind}`;
    const existing = map.get(key);
    if (existing) {
      existing.repos.push(e.repo);
    } else {
      map.set(key, {
        endpoint: e.endpoint,
        kind: e.kind,
        message:
          e.kind === "pending"
            ? "Still computing on GitHub"
            : e.kind === "forbidden"
              ? "No access (needs push permission)"
              : e.message,
        repos: [e.repo],
      });
    }
  }
  return [...map.values()].sort((a, b) => b.repos.length - a.repos.length);
}
