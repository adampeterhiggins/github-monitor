import { useState, type ReactNode } from "react";
import { useApp } from "../lib/state/app";
import {
  PERIODS,
  dayKey,
  formatDate,
  parseDayInput,
  resolvePeriod,
  weekSpan,
  type PeriodId,
} from "../lib/agg/weeks";
import { commitWeekBounds } from "../lib/db/queries";
import { useScope, useScopedQuery, type UserFilterSupport } from "../lib/hooks";
import { Button, Dropdown, DropdownRow } from "./ui";
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
  const customFrom = useApp((s) => s.customFrom);
  const customTo = useApp((s) => s.customTo);

  const active = PERIODS.find((p) => p.id === period);
  const range = resolvePeriod(period, {
    customFrom: customFrom ?? undefined,
    customTo: customTo ?? undefined,
  });

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-plane px-5 py-2.5">
      <Dropdown label={`Period: ${active?.label ?? "Custom"}`} width={252} align="left">
        {(close) => <PeriodMenu close={close} />}
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

/** A preset row for a span read out of the cache rather than counted back from now. */
function SpanRow({
  label,
  span,
  loading,
  active,
  applied,
  onApply,
}: {
  label: string;
  span: { from: number; to: number } | null;
  loading: boolean;
  /** Whether a custom range is the current period at all. */
  active: boolean;
  applied: { from: number | null; to: number | null };
  onApply: (span: { from: number; to: number }) => void;
}) {
  return (
    <DropdownRow
      selected={
        span != null && active && applied.from === span.from && applied.to === span.to
      }
      disabled={span == null}
      onClick={() => span && onApply(span)}
    >
      <span className="block truncate">{label}</span>
      <span className="block truncate text-[11px] text-ink-muted">
        {span
          ? `${formatDate(span.from)} – ${formatDate(span.to)}`
          : loading
            ? "Looking…"
            : "No commits cached"}
      </span>
    </DropdownRow>
  );
}

const DATE_INPUT =
  "h-7 min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface px-1.5 text-[12px] text-ink " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The presets, then a pair of dates for anything they do not cover.
 *
 * Its own component because the two fields are edited before they are applied:
 * typing a start date should not re-scope the whole page on every keystroke, and
 * a half-entered range is not a range.
 */
function PeriodMenu({ close }: { close: () => void }) {
  const period = useApp((s) => s.period);
  const setPeriod = useApp((s) => s.setPeriod);
  const customFrom = useApp((s) => s.customFrom);
  const customTo = useApp((s) => s.customTo);
  const myLogin = useApp((s) => s.login);
  const scope = useScope();

  /**
   * The spans the cache actually holds commits for: everything in the current
   * selection, and just this account's.
   *
   * Only queried while the menu is open — it is mounted on open — so controls
   * nobody looked at cost nothing.
   */
  const allBounds = useScopedQuery(
    "commit-week-bounds",
    scope,
    (db) => commitWeekBounds(db, scope.repoIds, scope.logins),
    { staleTime: 5 * 60_000 },
  );

  /**
   * Deliberately not `scope.logins`: this one answers "when was I committing",
   * which is a different question from "when was whoever is filtered in".
   */
  const myBounds = useScopedQuery(
    "commit-week-bounds-me",
    scope,
    (db) => commitWeekBounds(db, scope.repoIds, myLogin ? [myLogin] : null),
    { staleTime: 5 * 60_000, enabled: myLogin != null },
  );

  const everything = weekSpan(allBounds.data);
  const mine = weekSpan(myBounds.data);

  // Seeded from whatever is on screen, so a custom range starts from the preset
  // you were looking at rather than from two empty fields.
  const showing = resolvePeriod(period, {
    customFrom: customFrom ?? undefined,
    customTo: customTo ?? undefined,
  });
  const [from, setFrom] = useState(() => dayKey(showing.fromMs));
  const [to, setTo] = useState(() => dayKey(showing.toMs));

  const fromMs = parseDayInput(from);
  const toMs = parseDayInput(to, true);
  const complete = fromMs != null && toMs != null;
  const backwards = complete && fromMs > toMs;

  const applied =
    period === "custom" && customFrom != null && customTo != null
      ? `${formatDate(customFrom)} – ${formatDate(customTo)}`
      : null;

  return (
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

      {/* These sit with the presets because that is what they are — but they resolve
          to the dates themselves, so the bar names a real span rather than "All
          time", which reaches back to 1970 whether or not anything is there. */}
      <SpanRow
        label="All commits"
        span={everything}
        loading={allBounds.isFetching}
        active={period === "custom"}
        applied={{ from: customFrom, to: customTo }}
        onApply={(span) => {
          setPeriod("custom", span);
          close();
        }}
      />
      {myLogin ? (
        <SpanRow
          label="My commits"
          span={mine}
          loading={myBounds.isFetching}
          active={period === "custom"}
          applied={{ from: customFrom, to: customTo }}
          onApply={(span) => {
            setPeriod("custom", span);
            close();
          }}
        />
      ) : null}

      <div className="mt-1 border-t border-hairline px-2.5 pb-1 pt-2">
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="w-4 shrink-0 text-[16px] font-bold leading-none text-ink">
            {period === "custom" ? "✓" : ""}
          </span>
          <span className="text-[12px] text-ink">Custom range</span>
        </div>

        <label className="mb-1.5 flex items-center gap-2 text-[11px] text-ink-secondary">
          <span className="w-8 shrink-0">From</span>
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className={DATE_INPUT}
          />
        </label>
        <label className="flex items-center gap-2 text-[11px] text-ink-secondary">
          <span className="w-8 shrink-0">To</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className={DATE_INPUT}
          />
        </label>

        <div className="mt-2 flex items-center justify-between gap-2 pb-1">
          <span className="min-w-0 truncate text-[11px] tabular text-ink-muted">
            {backwards ? "Start is after the end" : (applied ?? "")}
          </span>
          <Button
            variant="primary"
            disabled={!complete || backwards}
            onClick={() => {
              if (fromMs == null || toMs == null) return;
              setPeriod("custom", { from: fromMs, to: toMs });
              close();
            }}
          >
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}
