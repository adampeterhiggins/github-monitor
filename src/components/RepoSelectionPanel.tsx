import { useMemo, useRef, useState } from "react";
import { useApp } from "../lib/state/app";
import { activeRepoIds, useRepoSelectionData } from "../lib/repoSelection";
import { useRepoSync, type RepoSyncSummary } from "../lib/state/repoSync";
import { discoverAuthorRepos, type DiscoverProgress } from "../lib/ingest/discoverAuthorRepos";
import { GitHubClient } from "../lib/github/client";
import { formatDate } from "../lib/agg/weeks";
import type { RepoRow } from "../lib/db/queries";
import {
  Button,
  Callout,
  Card,
  CardHeader,
  Checkbox,
  DataTable,
  Spinner,
  compact,
  full,
} from "./ui";

/**
 * Repository selection, as a checkbox list rather than the compact dropdown in the
 * filter bar. This is the place to curate the set once; the dropdown is for quick
 * changes while reading a page. Both write to the same persisted selection.
 */
export function RepoSelectionPanel() {
  const repos = useApp((s) => s.repos);
  const selected = useApp((s) => s.selectedRepoIds);
  const setSelectedRepos = useApp((s) => s.setSelectedRepos);
  const token = useApp((s) => s.token);
  const login = useApp((s) => s.login);
  const setLogin = useApp((s) => s.setLogin);

  const { activity, myCommits, probe, hasCommitData, loading, refetchProbe } =
    useRepoSelectionData();
  const db = useApp((s) => s.db);
  const bumpProbeStamp = useApp((s) => s.bumpProbeStamp);

  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoverProgress | null>(null);
  const discoverAbort = useRef<AbortController | null>(null);

  // Per-repository sync, so one failed or still-computing repository can be
  // fixed without re-running the whole organisation.
  const repoSync = useRepoSync(useMemo(() => repos.map((r) => r.id), [repos]));
  const syncProgress = useApp((s) => s.sync);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos
      .filter((r) => (showArchived ? true : r.archived === 0))
      .filter((r) => (q ? r.full_name.toLowerCase().includes(q) : true));
  }, [repos, query, showArchived]);

  const apply = (ids: number[], message?: string) => {
    void setSelectedRepos(ids);
    setNotice(message ?? null);
  };

  /** Existing installs may have no stored login; fetch it on demand. */
  const detectAccount = async () => {
    if (!token) return;
    setDetecting(true);
    setNotice(null);
    try {
      const { login: who } = await new GitHubClient({ token }).verify();
      await setLogin(who);
      setNotice(`Signed in as ${who}.`);
    } catch (err) {
      setNotice(`Could not read your account: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      setDetecting(false);
    }
  };

  /**
   * Ask GitHub which repositories the signed-in user has committed to.
   *
   * Deliberately not read from the local cache: that would only ever return
   * repositories already synced, which is circular — the reason to choose
   * repositories is to avoid syncing all of them.
   */
  const discoverMine = async () => {
    if (!login || !token || !db) return;
    const controller = new AbortController();
    discoverAbort.current = controller;
    setNotice(null);

    const candidates = repos.filter((r) => (showArchived ? true : r.archived === 0));

    try {
      const result = await discoverAuthorRepos({
        db,
        token,
        login,
        repos: candidates,
        signal: controller.signal,
        onProgress: setDiscovery,
      });

      bumpProbeStamp();
      refetchProbe();

      if (result.repoIds.length === 0) {
        setNotice(
          `Checked ${full(result.requestsMade)} repositories and found no commits by ${login}.` +
            (result.unreadable.length
              ? ` ${full(result.unreadable.length)} could not be read (empty, or no access).`
              : ""),
        );
        return;
      }

      apply(
        result.repoIds,
        `Selected ${full(result.repoIds.length)} of ${full(result.requestsMade)} repositories with commits by ${login}` +
          (result.cancelled ? " (stopped early, partial result)." : ".") +
          (result.unreadable.length
            ? ` ${full(result.unreadable.length)} could not be read.`
            : ""),
      );
    } catch (err) {
      setNotice(`Could not check repositories: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      setDiscovery(null);
      discoverAbort.current = null;
    }
  };

  const myWithCommits = useMemo(
    () => [...myCommits.values()].filter((n) => n > 0).length,
    [myCommits],
  );

  const myTotal = useMemo(
    () => [...myCommits.values()].reduce((a, n) => a + n, 0),
    [myCommits],
  );

  const toggleVisible = (checked: boolean) => {
    const ids = new Set(visible.map((r) => r.id));
    apply(
      checked ? [...new Set([...selected, ...ids])] : selected.filter((id) => !ids.has(id)),
    );
  };

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selectedSet.has(r.id));

  return (
    <Card>
      <CardHeader
        title="Repositories"
        subtitle={`${full(selected.length)} of ${full(repos.length)} selected — every page aggregates across these`}
        actions={loading ? <Spinner /> : null}
      />

      {notice ? (
        <div className="mb-3">
          <Callout>{notice}</Callout>
        </div>
      ) : null}

      {discovery ? (
        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between gap-3 text-[12px]">
            <span className="flex items-center gap-2 text-ink">
              <Spinner /> Checking repositories for your commits
              {discovery.found > 0 ? ` — ${full(discovery.found)} found` : ""}
            </span>
            <span className="flex items-center gap-2">
              <span className="tabular text-ink-secondary">
                {full(discovery.done)} / {full(discovery.total)}
              </span>
              <Button variant="ghost" onClick={() => discoverAbort.current?.abort()}>
                Stop
              </Button>
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full"
            style={{ background: "var(--wash-strong)" }}
          >
            <div
              className="h-full rounded-full transition-[width]"
              style={{
                width: `${discovery.total ? Math.round((discovery.done / discovery.total) * 100) : 0}%`,
                background: "var(--accent)",
              }}
            />
          </div>
          {discovery.current ? (
            <p className="mt-1.5 truncate text-[11px] text-ink-muted">{discovery.current}</p>
          ) : null}
        </div>
      ) : null}

      {/* The requested auto-populate action, plus the other useful presets. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {login ? (
          <Button
            variant="primary"
            onClick={discoverMine}
            disabled={discovery != null || !token}
            title={`Ask GitHub which repositories ${login} has commits in — one request per repository, works without syncing first`}
          >
            Repositories I've committed in
          </Button>
        ) : (
          <Button variant="primary" onClick={detectAccount} disabled={detecting || !token}>
            {detecting ? <Spinner /> : null} Detect my GitHub account
          </Button>
        )}
        <Button onClick={() => apply(repos.map((r) => r.id), "Selected every repository.")}>
          Select all
        </Button>
        <Button onClick={() => apply([], "Cleared the selection.")}>Clear</Button>
        <Button
          title="Repositories pushed to in the last 12 months, excluding archived"
          onClick={() => {
            const ids = activeRepoIds(repos, 12);
            apply(ids, `Selected ${full(ids.length)} actively-developed repositories.`);
          }}
        >
          Active in last 12 months
        </Button>
        <Button
          title="Repositories with any cached commit activity"
          disabled={!hasCommitData}
          onClick={() => {
            const ids = repos.filter((r) => (activity.get(r.id)?.commits ?? 0) > 0).map((r) => r.id);
            apply(ids, `Selected ${full(ids.length)} repositories with commit activity.`);
          }}
        >
          Has any activity
        </Button>
      </div>

      {login ? (
        <p className="mb-3 text-[11px] text-ink-secondary">
          Signed in as <strong className="text-ink">{login}</strong>
          {myWithCommits > 0 ? (
            <>
              {" "}
              — {full(myWithCommits)} {myWithCommits === 1 ? "repository" : "repositories"} with your
              commits, {compact(myTotal)} in total.
            </>
          ) : null}
        </p>
      ) : null}

      <div className="mb-2 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter repositories…"
          className="h-7 min-w-[200px] flex-1 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink placeholder:text-ink-muted focus:outline-2 focus:outline-offset-0 focus:outline-accent"
        />
        <Checkbox
          checked={showArchived}
          onChange={setShowArchived}
          label={<span className="text-ink-secondary">Include archived</span>}
        />
        <Checkbox
          checked={allVisibleSelected}
          onChange={toggleVisible}
          label={<span className="text-ink-secondary">Select these {visible.length}</span>}
        />
      </div>

      <DataTable
        rows={visible}
        maxHeight={460}
        empty="No repositories match"
        rowKey={(r) => r.id}
        initialSort={{ key: "mine", dir: "desc" }}
        columns={[
          {
            key: "selected",
            header: "On",
            width: "36px",
            render: (r: RepoRow) => (
              <input
                type="checkbox"
                aria-label={`Include ${r.full_name}`}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
                checked={selectedSet.has(r.id)}
                onChange={() =>
                  apply(
                    selectedSet.has(r.id)
                      ? selected.filter((x) => x !== r.id)
                      : [...selected, r.id],
                  )
                }
              />
            ),
            sortValue: (r: RepoRow) => (selectedSet.has(r.id) ? 1 : 0),
          },
          {
            key: "name",
            header: "Repository",
            render: (r: RepoRow) => (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{r.name}</span>
                {r.archived ? (
                  <span className="shrink-0 rounded border border-hairline-strong px-1 text-[9px] uppercase text-ink-muted">
                    archived
                  </span>
                ) : null}
                {r.private ? (
                  <span className="shrink-0 text-[9px] uppercase text-ink-muted">private</span>
                ) : null}
              </span>
            ),
            sortValue: (r: RepoRow) => r.name,
          },
          {
            key: "mine",
            header: "My commits",
            align: "right",
            render: (r: RepoRow) => {
              const n = myCommits.get(r.id) ?? 0;
              if (n === 0) {
                // A probed zero is knowledge; an absent value is simply unchecked.
                return probe.has(r.id) ? (
                  <span className="text-ink-muted">0</span>
                ) : (
                  <span className="text-ink-muted">—</span>
                );
              }
              return <span className="text-ink">{compact(n)}</span>;
            },
            sortValue: (r: RepoRow) => myCommits.get(r.id) ?? -1,
          },
          {
            key: "total",
            header: "All commits",
            align: "right",
            render: (r: RepoRow) => {
              const n = Number(activity.get(r.id)?.commits ?? 0);
              return n > 0 ? compact(n) : <span className="text-ink-muted">—</span>;
            },
            sortValue: (r: RepoRow) => Number(activity.get(r.id)?.commits ?? 0),
          },
          {
            key: "pushed",
            header: "Last push",
            align: "right",
            render: (r: RepoRow) =>
              r.pushed_at ? formatDate(new Date(r.pushed_at)) : <span className="text-ink-muted">never</span>,
            sortValue: (r: RepoRow) => r.pushed_at ?? "",
          },
          {
            key: "sync",
            header: "Sync",
            width: "150px",
            render: (r: RepoRow) => (
              <RepoSyncCell
                repoId={r.id}
                summary={repoSync.summaries.get(r.id)}
                active={repoSync.activeRepoId === r.id}
                busy={repoSync.busy}
                label={repoSync.activeRepoId === r.id ? (syncProgress?.label ?? null) : null}
                onSync={repoSync.syncRepo}
              />
            ),
            // Least-complete first, so the ones needing attention sort to the top.
            sortValue: (r: RepoRow) => -(repoSync.summaries.get(r.id)?.outstanding ?? 0),
          },
        ]}
      />

      <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
        <strong className="text-ink">My commits</strong> comes from GitHub directly when you use
        “Repositories I've committed in”, so it works before any sync; a dash means not yet
        checked, and 0 means checked with none found. <strong className="text-ink">All commits</strong>{" "}
        needs a sync, since GitHub only exposes full contributor statistics through its lazily
        computed endpoints.
      </p>
    </Card>
  );
}

/**
 * Per-row sync status and action.
 *
 * "Resume" and "Re-sync" are distinguished deliberately: resuming a repository
 * fetches only its outstanding endpoints, whereas re-syncing a complete one has
 * to redo all of them, and the button should not hide which of those it is about
 * to do.
 */
function RepoSyncCell({
  repoId,
  summary,
  active,
  busy,
  label,
  onSync,
}: {
  repoId: number;
  summary: RepoSyncSummary | undefined;
  active: boolean;
  busy: boolean;
  label: string | null;
  onSync: (repoId: number, mode: "resume" | "full") => Promise<void>;
}) {
  if (active) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-ink" title={label ?? undefined}>
        <Spinner /> <span className="truncate">{label ?? "Syncing…"}</span>
      </span>
    );
  }

  if (!summary) {
    return <span className="text-[11px] text-ink-muted">—</span>;
  }

  const { state, outstanding, pending, errored } = summary;

  return (
    <span className="flex items-center justify-between gap-2" title={summary.detail}>
      <span className="text-[11px]">
        {state === "complete" ? (
          <span style={{ color: "var(--status-good)" }}>● synced</span>
        ) : state === "never" ? (
          <span className="text-ink-muted">not synced</span>
        ) : (
          <span style={{ color: errored > 0 ? "var(--status-critical)" : "var(--status-warning)" }}>
            {errored > 0 ? "▲" : "◆"} {full(outstanding)} left
            {pending > 0 ? ` (${full(pending)} computing)` : ""}
          </span>
        )}
      </span>
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => void onSync(repoId, state === "complete" ? "full" : "resume")}
        title={
          state === "complete"
            ? "Re-fetch everything for this repository"
            : "Fetch only what is outstanding for this repository"
        }
      >
        {state === "complete" ? "Re-sync" : state === "never" ? "Sync" : "Resume"}
      </Button>
    </span>
  );
}
