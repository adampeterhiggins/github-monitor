import { useMemo } from "react";
import { useApp } from "../lib/state/app";
import { Button, Checkbox, Dropdown, OnlyButton, full } from "./ui";

/**
 * Organisation filter, shown only when more than one organisation or user is
 * connected. It has no state of its own: it reads and writes the repository
 * selection, so an organisation is ticked when all of its repositories are and
 * every page keeps scoping by repository alone.
 */
export function OrgFilter() {
  const orgs = useApp((s) => s.orgs);
  const allRepos = useApp((s) => s.repos);
  const excludeForks = useApp((s) => s.excludeForks);
  const selected = useApp((s) => s.selectedRepoIds);
  const setSelectedRepos = useApp((s) => s.setSelectedRepos);

  const repoIdsByOrg = useMemo(() => {
    const byOrg = new Map(orgs.map((o) => [o.toLowerCase(), [] as number[]]));
    for (const r of allRepos) {
      if (excludeForks && r.fork) continue;
      byOrg.get(r.owner.toLowerCase())?.push(r.id);
    }
    return byOrg;
  }, [orgs, allRepos, excludeForks]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const stateOf = (org: string) => {
    const ids = repoIdsByOrg.get(org.toLowerCase()) ?? [];
    const count = ids.filter((id) => selectedSet.has(id)).length;
    return { ids, count, all: ids.length > 0 && count === ids.length, some: count > 0 };
  };

  if (orgs.length < 2) return null;

  const states = orgs.map((org) => ({ org, ...stateOf(org) }));
  const fullyIncluded = states.filter((s) => s.all);
  const touched = states.filter((s) => s.some);

  const label = (() => {
    if (touched.length === 0) return "No organisations";
    if (fullyIncluded.length === orgs.length) return `All ${full(orgs.length)} organisations`;
    if (touched.length === 1) return touched[0].all ? touched[0].org : `${touched[0].org} (partial)`;
    return `${full(touched.length)} of ${full(orgs.length)} organisations`;
  })();

  const apply = (ids: number[]) => void setSelectedRepos(ids);

  const toggle = (ids: number[], checked: boolean) => {
    const drop = new Set(ids);
    apply(checked ? [...new Set([...selected, ...ids])] : selected.filter((id) => !drop.has(id)));
  };

  return (
    <Dropdown label={<span className="max-w-[200px] truncate">{label}</span>} width={280} align="left">
      <div className="flex flex-col">
        <div className="flex items-center gap-1.5 border-b border-hairline p-2">
          <Button variant="ghost" onClick={() => apply([...repoIdsByOrg.values()].flat())}>
            Select all
          </Button>
          <Button variant="ghost" onClick={() => apply([])}>
            Clear
          </Button>
        </div>
        <div className="overflow-y-auto p-1.5" style={{ maxHeight: 360 }}>
          {states.map((s) => (
            <div key={s.org} className="group flex items-center rounded px-1.5 py-[3px] hover:bg-wash">
              <div className="min-w-0 flex-1">
                <Checkbox
                  checked={s.all}
                  indeterminate={s.some}
                  disabled={s.ids.length === 0}
                  onChange={(checked) => toggle(s.ids, checked)}
                  label={s.org}
                />
              </div>
              <OnlyButton name={s.org} onClick={() => apply(s.ids)} />
              <span
                className="ml-2 shrink-0 text-[10px] tabular text-ink-muted"
                title={`${full(s.count)} of ${full(s.ids.length)} repositories selected`}
              >
                {full(s.count)}/{full(s.ids.length)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Dropdown>
  );
}
