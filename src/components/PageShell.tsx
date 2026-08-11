import type { ReactNode } from "react";
import { FilterBar } from "./FilterBar";
import { EmptyState } from "./ui";
import { useApp } from "../lib/state/app";
import { useScope } from "../lib/hooks";

/**
 * Common page frame: heading, the single filter row, then scrollable content.
 * Pages that need no repo/date scoping pass `filters={false}`.
 */
export function PageShell({
  title,
  subtitle,
  children,
  filters = true,
  filterExtra,
  requiresData = true,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  filters?: boolean;
  filterExtra?: ReactNode;
  requiresData?: boolean;
}) {
  const scope = useScope();
  const lastSyncAt = useApp((s) => s.lastSyncAt);
  const repos = useApp((s) => s.repos);

  const blocked = requiresData && (!lastSyncAt || repos.length === 0 || scope.repoIds.length === 0);

  return (
    <>
      <header className="border-b border-hairline bg-plane px-5 pt-4 pb-3">
        <h1 className="text-[20px] font-semibold leading-tight text-ink">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-[12.5px] text-ink-secondary">{subtitle}</p> : null}
      </header>

      {filters ? <FilterBar extra={filterExtra} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {blocked ? (
          <EmptyState
            title={
              !lastSyncAt || repos.length === 0
                ? "No data cached yet"
                : "No repositories selected"
            }
            body={
              !lastSyncAt || repos.length === 0
                ? "Run a sync from Settings & sync to pull this organisation's analytics into the local cache."
                : "Pick at least one repository in the filter above."
            }
          />
        ) : (
          children
        )}
      </div>
    </>
  );
}
