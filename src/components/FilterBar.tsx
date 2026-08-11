import type { ReactNode } from "react";
import { useApp } from "../lib/state/app";
import { PERIODS, formatDate, resolvePeriod, type PeriodId } from "../lib/agg/weeks";
import type { UserFilterSupport } from "../lib/hooks";
import { Dropdown, DropdownRow } from "./ui";
import { RepoFilter } from "./RepoFilter";
import { UserFilter } from "./UserFilter";

/**
 * One filter row, above the content it scopes. Date range comes first because it
 * is the control readers reach for; presets are rows rather than a calendar grid.
 * Everything below re-renders against the same slice, so the numbers always agree.
 */
export function FilterBar({
  extra,
  userFilter = "full",
}: {
  extra?: ReactNode;
  userFilter?: UserFilterSupport;
}) {
  const period = useApp((s) => s.period);
  const setPeriod = useApp((s) => s.setPeriod);

  const active = PERIODS.find((p) => p.id === period);
  const range = resolvePeriod(period);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-plane px-5 py-2.5">
      <Dropdown label={`Period: ${active?.label ?? "Custom"}`} width={220} align="left">
        {(close) => (
          <div className="py-1">
            {PERIODS.map((p) => (
              <DropdownRow
                key={p.id}
                selected={p.id === period}
                onClick={() => {
                  setPeriod(p.id as PeriodId);
                  close();
                }}
              >
                {p.label}
              </DropdownRow>
            ))}
          </div>
        )}
      </Dropdown>

      <RepoFilter />
      <UserFilter support={userFilter} />

      {extra}

      <span className="ml-auto text-[11px] tabular text-ink-muted">
        {period === "all"
          ? "All available history"
          : `${formatDate(range.fromMs)} – ${formatDate(range.toMs)}`}
      </span>
    </div>
  );
}
