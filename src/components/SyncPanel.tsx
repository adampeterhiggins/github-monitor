import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApp } from "../lib/state/app";
import { ALL_ENDPOINTS, ENDPOINT_LABELS, runSync, type EndpointId, type SyncError } from "../lib/ingest/sync";
import { Button, Callout, Card, CardHeader, DataTable, Spinner, full } from "./ui";

/**
 * Sync control. The progress detail matters more here than in a typical app: the
 * `stats/*` endpoints are computed lazily by GitHub and answer 202 while cold, so
 * a first sync legitimately takes minutes and parks on "waiting for GitHub". Without
 * a visible warm/collect breakdown that looks like a hang.
 */
export function SyncPanel({ compact: compactView = false }: { compact?: boolean }) {
  const { db, token, org, sync, syncing, setSync, setSyncing, reloadSyncTime, refreshRepos } = useApp();
  const abortRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();
  const [selectedEndpoints, setSelectedEndpoints] = useState<EndpointId[]>(ALL_ENDPOINTS);
  const [fatal, setFatal] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (!db || !token || !org) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setFatal(null);
    setSyncing(true);
    try {
      await runSync({
        db,
        token,
        org,
        endpoints: selectedEndpoints,
        signal: controller.signal,
        onProgress: setSync,
      });
      await refreshRepos();
      await reloadSyncTime();
      // Every page reads from SQLite, so invalidating clears all of them at once.
      await queryClient.invalidateQueries();
    } catch (err) {
      setFatal((err as Error)?.message ?? String(err));
    } finally {
      setSyncing(false);
      abortRef.current = null;
    }
  }, [db, token, org, selectedEndpoints, setSync, setSyncing, refreshRepos, reloadSyncTime, queryClient]);

  const cancel = () => abortRef.current?.abort();

  const grouped = useMemo(() => groupErrors(sync?.errors ?? []), [sync?.errors]);

  const pct = sync && sync.total > 0 ? Math.round((sync.done / sync.total) * 100) : 0;

  return (
    <Card>
      <CardHeader
        title="Sync"
        subtitle={
          org ? `Pulling analytics for ${org} into the local cache` : "Choose an organisation first"
        }
        actions={
          syncing ? (
            <Button variant="danger" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button variant="primary" onClick={start} disabled={!db || !token || !org}>
              Sync now
            </Button>
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
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {ALL_ENDPOINTS.map((e) => (
                <label key={e} className="flex cursor-pointer items-center gap-2 text-[12px] text-ink">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[var(--accent)]"
                    checked={selectedEndpoints.includes(e)}
                    disabled={syncing}
                    onChange={(ev) =>
                      setSelectedEndpoints((prev) =>
                        ev.target.checked ? [...prev, e] : prev.filter((x) => x !== e),
                      )
                    }
                  />
                  {ENDPOINT_LABELS[e]}
                </label>
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
