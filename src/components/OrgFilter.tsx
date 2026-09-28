import { useMemo } from "react";
import { useApp } from "../lib/state/app";
import { Button, Checkbox, Dropdown, OnlyButton, full } from "./ui";

/**
 * Organisation filter, shown only when more than one organisation or user is
 * connected. Switching an organisation off removes its repositories from the
 * repository filter and from every page, without touching which of them are
 * selected, so switching it back on restores the same selection.
 */
export function OrgFilter() {
  const orgs = useApp((s) => s.orgs);
  const allRepos = useApp((s) => s.repos);
  const excludeForks = useApp((s) => s.excludeForks);
  const selected = useApp((s) => s.selectedRepoIds);
  const hiddenOrgs = useApp((s) => s.hiddenOrgs);
  const setHiddenOrgs = useApp((s) => s.setHiddenOrgs);

  const counts = useMemo(() => {
    const selectedSet = new Set(selected);
    const byOrg = new Map(orgs.map((o) => [o.toLowerCase(), { total: 0, selected: 0 }]));
    for (const r of allRepos) {
      if (excludeForks && r.fork) continue;
      const c = byOrg.get(r.owner.toLowerCase());
      if (!c) continue;
      c.total++;
      if (selectedSet.has(r.id)) c.selected++;
    }
    return byOrg;
  }, [orgs, allRepos, excludeForks, selected]);

  if (orgs.length < 2) return null;

  const hidden = new Set(hiddenOrgs);
  const shown = orgs.filter((o) => !hidden.has(o.toLowerCase()));

  const label = (() => {
    if (shown.length === 0) return "No organisations";
    if (shown.length === orgs.length) return `All ${full(orgs.length)} organisations`;
    if (shown.length === 1) return shown[0];
    return `${full(shown.length)} of ${full(orgs.length)} organisations`;
  })();

  const toggle = (org: string, on: boolean) => {
    const key = org.toLowerCase();
    setHiddenOrgs(on ? hiddenOrgs.filter((o) => o !== key) : [...hiddenOrgs, key]);
  };

  return (
    <Dropdown label={<span className="max-w-[200px] truncate">{label}</span>} width={280} align="left">
      <div className="flex flex-col">
        <div className="flex items-center gap-1.5 border-b border-hairline p-2">
          <Button variant="ghost" onClick={() => setHiddenOrgs([])}>
            Select all
          </Button>
          <Button variant="ghost" onClick={() => setHiddenOrgs(orgs)}>
            Clear
          </Button>
        </div>
        <div className="overflow-y-auto p-1.5" style={{ maxHeight: 360 }}>
          {orgs.map((org) => {
            const c = counts.get(org.toLowerCase()) ?? { total: 0, selected: 0 };
            return (
              <div key={org} className="group flex items-center rounded px-1.5 py-[3px] hover:bg-wash">
                <div className="min-w-0 flex-1">
                  <Checkbox
                    checked={!hidden.has(org.toLowerCase())}
                    onChange={(on) => toggle(org, on)}
                    label={org}
                  />
                </div>
                <OnlyButton name={org} onClick={() => setHiddenOrgs(orgs.filter((o) => o !== org))} />
                <span
                  className="ml-2 shrink-0 text-[10px] tabular text-ink-muted"
                  title={`${full(c.selected)} of ${full(c.total)} repositories selected`}
                >
                  {full(c.selected)}/{full(c.total)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </Dropdown>
  );
}
