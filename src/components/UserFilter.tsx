import { useMemo, useState } from "react";
import { useApp } from "../lib/state/app";
import { useScope, useScopedQuery, type UserFilterSupport } from "../lib/hooks";
import { listContributors } from "../lib/db/queries";
import { Button, Checkbox, Dropdown, DropdownRow, compact, full } from "./ui";

/**
 * Contributor filter.
 *
 * GitHub's Insights pages have no equivalent — they show every contributor to one
 * repository. Here it narrows whichever pages carry a contributor dimension.
 *
 * `support` controls how it presents itself: on pages where GitHub supplies no
 * per-contributor breakdown the control is disabled and says why, rather than
 * appearing to work and quietly changing nothing.
 */

type UserSort = "commits" | "name" | "repos";

const SORTS: Array<{ id: UserSort; label: string }> = [
  { id: "commits", label: "Commits in period" },
  { id: "name", label: "Name (A–Z)" },
  { id: "repos", label: "Repositories touched" },
];

const SORT_KEY = "github-monitor.userSort";
const HIDE_KEY = "github-monitor.userHideInactive";

export function UserFilter({ support }: { support: UserFilterSupport }) {
  const scope = useScope();
  const selected = useApp((s) => s.selectedLogins);
  const setSelectedLogins = useApp((s) => s.setSelectedLogins);
  const myLogin = useApp((s) => s.login);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<UserSort>(
    () => (localStorage.getItem(SORT_KEY) as UserSort) || "commits",
  );
  const [hideInactive, setHideInactive] = useState(
    () => localStorage.getItem(HIDE_KEY) !== "false",
  );

  const applySort = (s: UserSort) => {
    localStorage.setItem(SORT_KEY, s);
    setSort(s);
  };
  const applyHide = (v: boolean) => {
    localStorage.setItem(HIDE_KEY, String(v));
    setHideInactive(v);
  };

  // Aggregates are scoped to the period; identity is not, so someone quiet now is
  // still selectable in order to look at their history.
  const contributors = useScopedQuery(
    "contributor-list",
    scope,
    (db) => listContributors(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek),
    { staleTime: 5 * 60_000 },
  );

  const all = contributors.data ?? [];
  const selectedSet = useMemo(() => new Set(selected.map((l) => l.toLowerCase())), [selected]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = all
      .filter((c) => (q ? c.login.toLowerCase().includes(q) : true))
      // A selected contributor is never hidden — otherwise the page would be
      // scoped by someone invisible in the control that scopes it.
      .filter(
        (c) => !hideInactive || Number(c.commits) > 0 || selectedSet.has(c.login.toLowerCase()),
      );

    return [...rows].sort((a, b) => {
      if (sort === "name") return a.login.localeCompare(b.login);
      if (sort === "repos") {
        const diff = Number(b.repos) - Number(a.repos);
        return diff !== 0 ? diff : a.login.localeCompare(b.login);
      }
      const diff = Number(b.commits) - Number(a.commits);
      return diff !== 0 ? diff : a.login.localeCompare(b.login);
    });
  }, [all, query, hideInactive, selectedSet, sort]);

  const hiddenCount = useMemo(
    () =>
      hideInactive
        ? all.filter(
            (c) => Number(c.commits) === 0 && !selectedSet.has(c.login.toLowerCase()),
          ).length
        : 0,
    [all, hideInactive, selectedSet],
  );

  if (support === "none") {
    return (
      <span
        className="inline-flex h-7 cursor-not-allowed items-center rounded-md border border-dashed border-hairline px-2.5 text-[12px] text-ink-muted"
        title="GitHub provides no per-contributor breakdown for this data, so it cannot be filtered by person."
      >
        Contributors: not available here
      </span>
    );
  }

  const label = (() => {
    if (selected.length === 0) return "All contributors";
    if (selected.length === 1) return selected[0];
    return `${full(selected.length)} contributors`;
  })();

  const apply = (logins: string[]) => setSelectedLogins(logins);

  return (
    <Dropdown
      label={
        <span className="flex max-w-[220px] items-center gap-1.5">
          <span className="truncate">{label}</span>
          {support === "partial" && selected.length > 0 ? (
            <span
              className="shrink-0 text-[10px] text-ink-muted"
              title="Some charts on this page have no contributor dimension and stay unfiltered."
            >
              (partial)
            </span>
          ) : null}
        </span>
      }
      width={400}
      align="left"
    >
      <div className="flex flex-col" style={{ maxHeight: 520 }}>
        <div className="border-b border-hairline p-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter contributors…"
            className="h-7 w-full rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink placeholder:text-ink-muted focus:outline-2 focus:outline-offset-0 focus:outline-accent"
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button variant="ghost" onClick={() => apply([])}>
              All contributors
            </Button>
            {myLogin ? (
              <Button variant="ghost" onClick={() => apply([myLogin])} title={`Only ${myLogin}`}>
                Just me
              </Button>
            ) : null}
            <Button
              variant="ghost"
              title="The ten contributors with the most commits in the selected period"
              onClick={() => apply(visible.slice(0, 10).map((c) => c.login))}
            >
              Top 10
            </Button>
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <Dropdown
              label={`Sort: ${SORTS.find((s) => s.id === sort)!.label}`}
              width={190}
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
                  Hide inactive{hiddenCount > 0 ? ` (${full(hiddenCount)})` : ""}
                </span>
              }
            />
          </div>
        </div>

        <div className="overflow-y-auto p-1.5">
          {contributors.isLoading ? (
            <p className="px-1.5 py-3 text-center text-[12px] text-ink-secondary">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="px-1.5 py-3 text-center text-[12px] text-ink-secondary">
              {all.length === 0
                ? "No contributor data cached yet — run a sync first."
                : hideInactive
                  ? "Nobody committed in this period. Untick “Hide inactive” to see everyone."
                  : "No contributors match"}
            </p>
          ) : (
            visible.map((c) => {
              const periodCommits = Number(c.commits);
              return (
                <div key={c.login} className="flex items-center gap-2 px-1.5 py-[3px]">
                  <div className="min-w-0 flex-1">
                    <Checkbox
                      checked={selectedSet.has(c.login.toLowerCase())}
                      onChange={() =>
                        apply(
                          selectedSet.has(c.login.toLowerCase())
                            ? selected.filter((l) => l.toLowerCase() !== c.login.toLowerCase())
                            : [...selected, c.login],
                        )
                      }
                      label={
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{c.login}</span>
                          {myLogin && c.login.toLowerCase() === myLogin.toLowerCase() ? (
                            <span className="shrink-0 text-[9px] uppercase text-ink-muted">you</span>
                          ) : null}
                        </span>
                      }
                    />
                  </div>
                  <span
                    className="shrink-0 text-[10px] tabular text-ink-muted"
                    title={
                      periodCommits > 0
                        ? `${full(periodCommits)} commits across ${full(Number(c.repos))} repositories in this period`
                        : `No commits in this period; ${full(Number(c.commits_all))} all time`
                    }
                  >
                    {periodCommits > 0
                      ? `${compact(periodCommits)} · ${full(Number(c.repos))} repo${
                          Number(c.repos) === 1 ? "" : "s"
                        }`
                      : "—"}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-hairline px-2.5 py-1.5">
          <span className="text-[11px] text-ink-muted">
            {selected.length === 0 ? "No filter applied" : `${full(selected.length)} selected`}
          </span>
          {selected.length > 0 ? (
            <Button variant="ghost" onClick={() => apply([])}>
              Clear
            </Button>
          ) : null}
        </div>
      </div>
    </Dropdown>
  );
}
