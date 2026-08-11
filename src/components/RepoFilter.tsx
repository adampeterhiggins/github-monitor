import { useMemo, useState } from "react";
import { useApp } from "../lib/state/app";
import { activeRepoIds, myRepoIds, useRepoSelectionData } from "../lib/repoSelection";
import { Button, Checkbox, Dropdown, full } from "./ui";
import type { RepoRow } from "../lib/db/queries";

/**
 * The repo filter. GitHub scopes Insights to a single repository; here repository
 * is a dimension you slice by, so this control is what every page reads from.
 */
export function RepoFilter() {
  const repos = useApp((s) => s.repos);
  const selected = useApp((s) => s.selectedRepoIds);
  const setSelectedRepos = useApp((s) => s.setSelectedRepos);
  const { mine, login } = useRepoSelectionData();
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos
      .filter((r) => (showArchived ? true : r.archived === 0))
      .filter((r) => (q ? r.name.toLowerCase().includes(q) : true));
  }, [repos, query, showArchived]);

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
    <Dropdown label={<span className="max-w-[220px] truncate">{label}</span>} width={340} align="left">
      <div className="flex flex-col" style={{ maxHeight: 460 }}>
        <div className="border-b border-hairline p-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter repositories…"
            className="h-7 w-full rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink placeholder:text-ink-muted focus:outline-2 focus:outline-offset-0 focus:outline-accent"
          />
          <div className="mt-2 flex items-center gap-1.5">
            <Button variant="ghost" onClick={() => toggleVisible(true)}>
              Select all
            </Button>
            <Button variant="ghost" onClick={() => toggleVisible(false)}>
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
                title={`Repositories with a cached commit by ${login}`}
                disabled={mine.size === 0}
                onClick={() => apply(myRepoIds(repos, mine))}
              >
                Mine
              </Button>
            ) : null}
          </div>
        </div>

        <div className="overflow-y-auto p-1.5">
          {visible.length === 0 ? (
            <p className="px-1.5 py-3 text-center text-[12px] text-ink-secondary">
              No repositories match
            </p>
          ) : (
            <>
              <div className="px-1.5 py-1">
                <Checkbox
                  checked={allVisibleSelected}
                  indeterminate={someVisibleSelected}
                  onChange={toggleVisible}
                  label={
                    <span className="font-medium">
                      {query || !showArchived ? `These ${visible.length}` : "Everything"}
                    </span>
                  }
                />
              </div>
              <div className="my-1 border-t border-hairline" />
              {visible.map((r) => (
                <div key={r.id} className="px-1.5 py-[3px]">
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

function RepoLabel({ repo }: { repo: RepoRow }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{repo.name}</span>
      {repo.archived ? (
        <span className="shrink-0 rounded border border-hairline-strong px-1 text-[9px] uppercase text-ink-muted">
          archived
        </span>
      ) : null}
      {repo.private ? (
        <span className="shrink-0 text-[9px] uppercase text-ink-muted">private</span>
      ) : null}
    </span>
  );
}
