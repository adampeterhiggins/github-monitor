import { useMemo, useState } from "react";
import { useApp } from "../lib/state/app";
import { activeRepoIds, myRepoIds, useRepoSelectionData } from "../lib/repoSelection";
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

  const { activity, mine, hasCommitData, loading } = useRepoSelectionData();

  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);

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

  const selectMine = () => {
    if (!login) return;
    const ids = myRepoIds(repos, mine);
    if (ids.length === 0) {
      setNotice(
        hasCommitData
          ? `No cached commits by ${login} in any synced repository. If you have only just added repositories, run a sync first.`
          : "No commit data cached yet — run a sync before using this.",
      );
      return;
    }
    apply(
      ids,
      `Selected ${full(ids.length)} ${ids.length === 1 ? "repository" : "repositories"} with commits by ${login}.`,
    );
  };

  const myTotal = useMemo(
    () => [...mine.values()].reduce((a, r) => a + Number(r.commits), 0),
    [mine],
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

      {/* The requested auto-populate action, plus the other useful presets. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {login ? (
          <Button
            variant="primary"
            onClick={selectMine}
            disabled={!hasCommitData}
            title={
              hasCommitData
                ? `Select every repository with a cached commit by ${login}`
                : "Run a sync first so there is commit data to search"
            }
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
          {hasCommitData ? (
            <>
              {" "}
              — {full(mine.size)} {mine.size === 1 ? "repository" : "repositories"} with your
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
              const n = Number(mine.get(r.id)?.commits ?? 0);
              return n > 0 ? (
                <span className="text-ink">{compact(n)}</span>
              ) : (
                <span className="text-ink-muted">—</span>
              );
            },
            sortValue: (r: RepoRow) => Number(mine.get(r.id)?.commits ?? 0),
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
        ]}
      />

      {!hasCommitData ? (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
          Commit columns and the activity presets read from the local cache, so they stay empty
          until a sync has run. They cost no API requests once populated.
        </p>
      ) : null}
    </Card>
  );
}
