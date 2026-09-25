import { useMemo, useState } from "react";
import { useApp } from "../lib/state/app";
import { useScope, useScopedQuery } from "../lib/hooks";
import { activeRepoIds, myRepoIds, useRepoSelectionData } from "../lib/repoSelection";
import { commitsByRepo } from "../lib/db/queries";
import { formatDate } from "../lib/agg/weeks";
import { Button, Checkbox, Dropdown, DropdownRow, OnlyButton, compact, full } from "./ui";
import { SavedSelections } from "./SavedSelections";
import type { RepoRow } from "../lib/db/queries";

/**
 * The repo filter. GitHub scopes Insights to a single repository; here repository
 * is a dimension you slice by, so this control is what every page reads from.
 */

type RepoSort = "commits" | "name" | "pushed";

const SORTS: Array<{ id: RepoSort; label: string }> = [
  { id: "commits", label: "Commits in period" },
  { id: "name", label: "Name (A–Z)" },
  { id: "pushed", label: "Last push" },
];

const SORT_KEY = "github-monitor.repoSort";
const HIDE_KEY = "github-monitor.repoHideInactive";

export function RepoFilter() {
  const allRepos = useApp((s) => s.repos);
  const excludeForks = useApp((s) => s.excludeForks);
  const repos = useMemo(() => (excludeForks ? allRepos.filter((r) => !r.fork) : allRepos), [allRepos, excludeForks]);
  const selected = useApp((s) => s.selectedRepoIds);
  const setSelectedRepos = useApp((s) => s.setSelectedRepos);
  const { myCommits, login } = useRepoSelectionData();
  const scope = useScope();

  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<RepoSort>(
    () => (localStorage.getItem(SORT_KEY) as RepoSort) || "commits",
  );
  // Defaults to hiding: on a 212-repository org most are dormant in any given
  // window, and scrolling past them to reach the handful that matter is the
  // common case rather than the exception.
  const [hideInactive, setHideInactive] = useState(
    () => localStorage.getItem(HIDE_KEY) !== "false",
  );

  const applySort = (s: RepoSort) => {
    localStorage.setItem(SORT_KEY, s);
    setSort(s);
  };
  const applyHide = (v: boolean) => {
    localStorage.setItem(HIDE_KEY, String(v));
    setHideInactive(v);
  };

  /**
   * Commits per repository in the current period. Deliberately queried across
   * *every* repository rather than the selected ones, since the whole point is to
   * decide what to select.
   */
  const allRepoIds = useMemo(() => repos.map((r) => r.id), [repos]);
  const totals = useScopedQuery(
    "repo-filter-totals",
    scope,
    (db) => commitsByRepo(db, allRepoIds, scope.range.fromWeek, scope.range.toWeek, scope.logins),
    { enabled: scope.db != null && allRepoIds.length > 0 },
  );

  const commitsById = useMemo(
    () => new Map((totals.data ?? []).map((r) => [r.id, Number(r.commits)])),
    [totals.data],
  );

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = repos
      .filter((r) => (showArchived ? true : r.archived === 0))
      .filter((r) => (q ? r.name.toLowerCase().includes(q) : true))
      // Hides on activity alone. Exempting selected repositories was the first
      // attempt, on the grounds that a hidden one still scopes the page — but with
      // everything selected by default that exempted almost everything, and the
      // control appeared broken. The count below reports selected-but-hidden
      // instead, which addresses the same concern without gutting the feature.
      .filter((r) => !hideInactive || (commitsById.get(r.id) ?? 0) > 0);

    return rows.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "pushed") return (b.pushed_at ?? "").localeCompare(a.pushed_at ?? "");
      const diff = (commitsById.get(b.id) ?? 0) - (commitsById.get(a.id) ?? 0);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
  }, [repos, query, showArchived, hideInactive, commitsById, selectedSet, sort]);

  /** Everything the activity rule is currently withholding. */
  const hidden = useMemo(() => {
    if (!hideInactive) return [] as RepoRow[];
    return repos.filter(
      (r) => (showArchived ? true : r.archived === 0) && (commitsById.get(r.id) ?? 0) === 0,
    );
  }, [repos, showArchived, hideInactive, commitsById]);

  /** Hidden but still selected, so still scoping every page. */
  const hiddenSelected = useMemo(
    () => hidden.filter((r) => selectedSet.has(r.id)),
    [hidden, selectedSet],
  );

  const label = (() => {
    if (repos.length === 0) return "Repositories";
    if (selected.length === 0) return "No repositories";
    if (selected.length === repos.length) return `All ${full(repos.length)} repositories`;
    if (selected.length === 1) {
      return repos.find((r) => r.id === selected[0])?.name ?? "1 repository";
    }
    return `${full(selected.length)} of ${full(repos.length)} repositories`;
  })();

  const apply = (ids: number[]) => void setSelectedRepos(ids);

  const toggleVisible = (checked: boolean) => {
    const visibleIds = new Set(visible.map((r) => r.id));
    apply(
      checked
        ? [...new Set([...selected, ...visibleIds])]
        : selected.filter((id) => !visibleIds.has(id)),
    );
  };

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selectedSet.has(r.id));
  const someVisibleSelected = visible.some((r) => selectedSet.has(r.id));

  return (
    <Dropdown label={<span className="max-w-[220px] truncate">{label}</span>} width={400} align="left">
      <div className="flex flex-col" style={{ maxHeight: 520 }}>
        <div className="border-b border-hairline p-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter repositories…"
            className="h-7 w-full rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink placeholder:text-ink-muted focus:outline-2 focus:outline-offset-0 focus:outline-accent"
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button variant="ghost" onClick={() => toggleVisible(true)}>
              Select all
            </Button>
            {/* Clears everything, not just what is on screen — otherwise hidden
                selections would survive a "clear" and keep scoping the page. */}
            <Button variant="ghost" onClick={() => apply([])}>
              Clear
            </Button>
            <Button
              variant="ghost"
              title="Repositories pushed to in the last 12 months"
              onClick={() => apply(activeRepoIds(repos, 12))}
            >
              Active only
            </Button>
            {login ? (
              <Button
                variant="ghost"
                title={`Repositories with a known commit by ${login} — use Settings to check every repository`}
                disabled={[...myCommits.values()].every((n) => n === 0)}
                onClick={() => apply(myRepoIds(repos, myCommits))}
              >
                Mine
              </Button>
            ) : null}
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <Dropdown
              label={`Sort: ${SORTS.find((s) => s.id === sort)!.label}`}
              width={180}
              align="left"
            >
              {(close) => (
                <div className="py-1">
                  {SORTS.map((s) => (
                    <DropdownRow
                      key={s.id}
                      selected={s.id === sort}
                      onClick={() => {
                        applySort(s.id);
                        close();
                      }}
                    >
                      {s.label}
                    </DropdownRow>
                  ))}
                </div>
              )}
            </Dropdown>
            <Checkbox
              checked={hideInactive}
              onChange={applyHide}
              label={
                <span className="text-ink-secondary">
                  Hide inactive{hidden.length > 0 ? ` (${full(hidden.length)})` : ""}
                </span>
              }
            />
          </div>
        </div>

        {hiddenSelected.length > 0 ? (
          <div className="flex items-center justify-between gap-2 border-b border-hairline bg-wash px-2 py-1.5">
            <span className="text-[11px] text-ink-secondary">
              {full(hiddenSelected.length)} selected {hiddenSelected.length === 1 ? "repository is" : "repositories are"}{" "}
              hidden here but still included.
            </span>
            <Button
              variant="ghost"
              title="Narrow the selection to repositories with commits in this period"
              onClick={() => {
                const drop = new Set(hiddenSelected.map((r) => r.id));
                apply(selected.filter((id) => !drop.has(id)));
              }}
            >
              Deselect them
            </Button>
          </div>
        ) : null}

        <SavedSelections
          kind="repos"
          currentValues={selected}
          suggested={`${selected.length} repositories`}
          onApply={(values) => {
            // Ids can outlive the repositories they point at, so drop any that no
            // longer exist rather than carrying phantom selections forward.
            const known = new Set(repos.map((r) => r.id));
            apply(values.map(Number).filter((id) => known.has(id)));
          }}
        />

        <div className="overflow-y-auto p-1.5">
          {visible.length === 0 ? (
            <p className="px-1.5 py-3 text-center text-[12px] text-ink-secondary">
              {hideInactive && repos.length > 0
                ? "No repositories with commits in this period. Untick “Hide inactive” to see the rest."
                : "No repositories match"}
            </p>
          ) : (
            <>
              <div className="px-1.5 py-1">
                <Checkbox
                  checked={allVisibleSelected}
                  indeterminate={someVisibleSelected}
                  onChange={toggleVisible}
                  label={<span className="font-medium">These {visible.length}</span>}
                />
              </div>
              <div className="my-1 border-t border-hairline" />
              {visible.map((r) => (
                <div key={r.id} className="group flex items-center rounded px-1.5 py-[3px] hover:bg-wash">
                  <div className="min-w-0 flex-1">
                    <Checkbox
                      checked={selectedSet.has(r.id)}
                      onChange={() =>
                        apply(
                          selectedSet.has(r.id)
                            ? selected.filter((x) => x !== r.id)
                            : [...selected, r.id],
                        )
                      }
                      label={<RepoLabel repo={r} />}
                    />
                  </div>
                  <OnlyButton name={r.name} onClick={() => apply([r.id])} />
                  <div className="ml-2">
                    <RepoMeta
                      commits={commitsById.get(r.id) ?? 0}
                      pushedAt={r.pushed_at}
                      sort={sort}
                    />
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-hairline px-2.5 py-1.5">
          <Checkbox
            checked={showArchived}
            onChange={setShowArchived}
            label={<span className="text-ink-secondary">Include archived</span>}
          />
          <span className="text-[11px] tabular text-ink-muted">{full(selected.length)} selected</span>
        </div>
      </div>
    </Dropdown>
  );
}

/** Commit count for the period, or the last push when sorting by that. */
function RepoMeta({
  commits,
  pushedAt,
  sort,
}: {
  commits: number;
  pushedAt: string | null;
  sort: RepoSort;
}) {
  if (sort === "pushed") {
    return (
      <span className="shrink-0 text-[10px] tabular text-ink-muted">
        {pushedAt ? formatDate(new Date(pushedAt)) : "never"}
      </span>
    );
  }
  return (
    <span
      className="shrink-0 text-[10px] tabular text-ink-muted"
      title={`${full(commits)} commits in the selected period`}
    >
      {commits > 0 ? compact(commits) : "—"}
    </span>
  );
}

function RepoLabel({ repo }: { repo: RepoRow }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{repo.name}</span>
      {repo.archived ? (
        <span className="shrink-0 rounded border border-hairline-strong px-1 text-[9px] uppercase text-ink-muted">
          archived
        </span>
      ) : null}
      {repo.fork ? (
        <span className="shrink-0 rounded border border-hairline-strong px-1 text-[9px] uppercase text-ink-muted">
          fork
        </span>
      ) : null}
      {repo.private ? (
        <span className="shrink-0 text-[9px] uppercase text-ink-muted">private</span>
      ) : null}
    </span>
  );
}
