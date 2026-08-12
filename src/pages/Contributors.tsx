import { useEffect, useMemo, useState } from "react";
import { useApp, type ContributionMetric } from "../lib/state/app";
import { useScope, useScopedQuery } from "../lib/hooks";
import {
  contributorRepoBreakdown,
  contributorWeeklyByLogin,
  contributorRepoWeeklyAll,
  contributorWeeklyTotals,
  listContributorMeta,
  weeklyByRepo,
  type ContributorWeekRow,
} from "../lib/db/queries";
import { buildStacks } from "../lib/agg/stacks";
import {
  GRANULARITIES,
  bucketLabel,
  rollUp,
  toCumulative,
  type Granularity,
} from "../lib/agg/series";
import { WEEK_SECONDS, axisWeeksFor, formatDate } from "../lib/agg/weeks";
import { PageShell } from "../components/PageShell";
import { Sparkline, TimelineArea, type TimelineShape } from "../components/charts";
import {
  Button,
  ChartCard,
  Card,
  DataTable,
  Dropdown,
  DropdownRow,
  EmptyState,
  Segmented,
  compact,
  full,
} from "../components/ui";

const METRICS: Array<{ id: ContributionMetric; label: string }> = [
  { id: "commits", label: "Commits" },
  { id: "additions", label: "Additions" },
  { id: "deletions", label: "Deletions" },
];

interface ContributorCard {
  login: string;
  avatar: string | null;
  url: string | null;
  commits: number;
  additions: number;
  deletions: number;
  weeks: Array<{ week: number; value: number }>;
}

export function Contributors() {
  const scope = useScope();
  const metric = useApp((s) => s.metric);
  const setMetric = useApp((s) => s.setMetric);
  const repos = useApp((s) => s.repos);
  const [limit, setLimit] = useState(24);
  /** How the org-wide chart is split. */
  const [breakdown, setBreakdown] = useState<"none" | "contributor" | "repository">("none");

  /**
   * Timeline view state. Persisted, because these are a way of reading the data
   * rather than a transient action, and re-choosing them on every visit is a chore.
   */
  const [shape, setShape] = useState<TimelineShape>(
    () => (localStorage.getItem("github-monitor.shape") as TimelineShape) || "bar",
  );
  const [stacked, setStacked] = useState(
    () => localStorage.getItem("github-monitor.stacked") !== "false",
  );
  const [cumulative, setCumulative] = useState(
    () => localStorage.getItem("github-monitor.cumulative") === "true",
  );
  const [granularity, setGranularity] = useState<Granularity>(
    () => (localStorage.getItem("github-monitor.granularity") as Granularity) || "week",
  );
  /** Series switched off via the legend. Empty means everything is shown. */
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());

  const persist = <T,>(key: string, value: T, set: (v: T) => void) => {
    localStorage.setItem(key, String(value));
    set(value);
  };

  /** How every contributor card is split. One control for all of them. */
  const [cardSplit, setCardSplit] = useState<"none" | "repository">(
    () => (localStorage.getItem("github-monitor.cardSplit") as "none" | "repository") || "none",
  );
  const setSplit = (mode: "none" | "repository") => {
    localStorage.setItem("github-monitor.cardSplit", mode);
    setCardSplit(mode);
  };

  const totals = useScopedQuery("contrib-totals", scope, (db) =>
    contributorWeeklyTotals(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek, scope.logins),
  );

  const perLogin = useScopedQuery("contrib-by-login", scope, (db) =>
    contributorWeeklyByLogin(
      db,
      scope.repoIds,
      scope.range.fromWeek,
      scope.range.toWeek,
      scope.logins,
    ),
  );

  const meta = useScopedQuery("contrib-meta", scope, (db) => listContributorMeta(db), {
    staleTime: 10 * 60_000,
  });

  // One query for every card's repository split, fetched only when it is on.
  const cardRepoWeekly = useScopedQuery(
    "contrib-card-repo-weekly",
    scope,
    (db) =>
      contributorRepoWeeklyAll(
        db,
        scope.repoIds,
        scope.range.fromWeek,
        scope.range.toWeek,
        scope.logins,
      ),
    { enabled: scope.ready && cardSplit === "repository" },
  );

  // Only fetched when the repository breakdown is on — it is a bigger result than
  // the plain totals and most views never need it.
  const byRepoWeekly = useScopedQuery(
    "contrib-by-repo-weekly",
    scope,
    (db) =>
      weeklyByRepo(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek, scope.logins),
    { enabled: scope.ready && breakdown === "repository" },
  );

  const selectedRepoCount = scope.repoIds.length;

  /** Every week in range, clamped to where data starts so "All time" stays sane. */
  const axisWeeks = useMemo(
    () =>
      axisWeeksFor(
        scope.range.fromWeek,
        scope.range.toWeek,
        (totals.data ?? []).map((r) => r.week),
      ),
    [scope.range.fromWeek, scope.range.toWeek, totals.data],
  );

  const masterSeries = useMemo(() => {
    const byWeek = new Map(totals.data?.map((r) => [r.week, r]) ?? []);
    return axisWeeks.map((week) => ({
      week,
      value: Number(byWeek.get(week)?.[metric] ?? 0),
    }));
  }, [totals.data, axisWeeks, metric]);

  /**
   * The brushed window, as indices into `axisWeeks`.
   *
   * Debounced: the brush fires continuously while dragging, and with "All time"
   * spanning thousands of weeks, recomputing every card on each event makes the
   * drag stutter.
   */
  const [brush, setBrush] = useState<{ start: number; end: number } | null>(null);
  const [pendingBrush, setPendingBrush] = useState<{ start: number; end: number } | null>(null);

  useEffect(() => {
    if (pendingBrush === null) return;
    const t = setTimeout(() => setBrush(pendingBrush), 60);
    return () => clearTimeout(t);
  }, [pendingBrush]);

  // A new period or repo selection changes the axis, so old indices are meaningless.
  useEffect(() => {
    setBrush(null);
    setPendingBrush(null);
  }, [scope.key]);

  /** Weeks the cards should cover: the brushed window, or the whole range. */
  const visibleWeeks = useMemo(() => {
    if (!brush || axisWeeks.length === 0) return axisWeeks;
    const last = axisWeeks.length - 1;
    const start = Math.max(0, Math.min(brush.start, last));
    const end = Math.max(start, Math.min(brush.end, last));
    return axisWeeks.slice(start, end + 1);
  }, [axisWeeks, brush]);

  const zoomed = visibleWeeks.length > 0 && visibleWeeks.length !== axisWeeks.length;

  /**
   * login -> week -> row. Built from the query result alone so that brushing does
   * not redo it; only the windowed slice below re-runs on a drag.
   */
  const byLogin = useMemo(() => {
    const out = new Map<string, Map<number, ContributorWeekRow>>();
    for (const row of perLogin.data ?? []) {
      let m = out.get(row.login);
      if (!m) {
        m = new Map();
        out.set(row.login, m);
      }
      m.set(row.week, row);
    }
    return out;
  }, [perLogin.data]);

  const cards = useMemo(() => {
    const metaByLogin = new Map(meta.data?.map((m) => [m.login, m]) ?? []);
    const out: ContributorCard[] = [];

    for (const [login, weeksByNumber] of byLogin) {
      let commits = 0;
      let additions = 0;
      let deletions = 0;
      const weeks: Array<{ week: number; value: number }> = [];

      // Totals are summed over the visible window too, so the figures on a card
      // always describe the chart beside them — which is what makes brushing
      // useful rather than confusing.
      for (const week of visibleWeeks) {
        const row = weeksByNumber.get(week);
        commits += Number(row?.commits ?? 0);
        additions += Number(row?.additions ?? 0);
        deletions += Number(row?.deletions ?? 0);
        weeks.push({ week, value: Number(row?.[metric] ?? 0) });
      }

      out.push({
        login,
        avatar: metaByLogin.get(login)?.avatar_url ?? null,
        url: metaByLogin.get(login)?.html_url ?? null,
        commits,
        additions,
        deletions,
        weeks,
      });
    }

    // Rank by the selected contribution type, as the repo-level page does. The
    // order therefore changes as the window changes, which is the point.
    return out.filter((c) => c[metric] > 0).sort((a, b) => b[metric] - a[metric]);
  }, [byLogin, meta.data, visibleWeeks, metric]);

  /**
   * The org-wide chart, split by contributor or repository.
   *
   * Both are derived from data already loaded for the cards where possible — the
   * contributor split reuses `perLogin` rather than issuing a second query.
   */
  const orgStack = useMemo(() => {
    if (breakdown === "contributor") {
      return buildStacks({
        rows: perLogin.data ?? [],
        weeks: visibleWeeks,
        weekOf: (r) => r.week,
        keyOf: (r) => r.login.toLowerCase(),
        labelOf: (r) => r.login,
        valueOf: (r) => Number(r[metric] ?? 0),
      });
    }
    if (breakdown === "repository") {
      return buildStacks({
        rows: byRepoWeekly.data ?? [],
        weeks: visibleWeeks,
        weekOf: (r) => r.week,
        keyOf: (r) => String(r.repo_id),
        labelOf: (r) => r.full_name.split("/").pop() ?? r.full_name,
        valueOf: (r) => Number(r[metric] ?? 0),
      });
    }
    return null;
  }, [breakdown, perLogin.data, byRepoWeekly.data, visibleWeeks, metric]);

  /**
   * One dataset for the org chart whichever view is selected: the breakdown when
   * there is one, otherwise a single total series. Rolled up and accumulated last,
   * so those two controls compose with every breakdown rather than each view
   * needing its own path.
   */
  const orgChart = useMemo(() => {
    const series = orgStack
      ? orgStack.series.map((sr) => ({ key: sr.key, label: sr.label, slot: sr.slot }))
      : [{ key: "total", label: METRICS.find((m) => m.id === metric)!.label, slot: 0 }];

    const base: Array<Record<string, number>> = orgStack
      ? orgStack.data
      : masterSeries.map((d) => ({ week: d.week, total: d.value }));

    const keys = series.map((sr) => sr.key);
    const rolled = rollUp(base, keys, granularity);
    return { series, data: cumulative ? toCumulative(rolled, keys) : rolled };
  }, [orgStack, masterSeries, metric, granularity, cumulative]);

  // A breakdown change invalidates which series exist, so a stale legend filter
  // would silently hide everything.
  useEffect(() => setActiveKeys(new Set()), [breakdown, metric]);

  const toggleKey = (key: string) =>
    setActiveKeys((prev) => {
      const all = orgChart.series.map((sr) => sr.key);
      // First click isolates; subsequent clicks add or remove. Emptying the set
      // returns to "everything", which is also its initial state.
      if (prev.size === 0) return new Set(all.filter((k) => k !== key));
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next.size === all.length ? new Set() : next;
    });

  /**
   * login -> stacked-by-repository series, built once for every card rather than
   * per card. Keyed lowercase to match the merged identities.
   */
  const cardStacks = useMemo(() => {
    if (cardSplit !== "repository") return null;
    const rowsByLogin = new Map<string, typeof cardRepoWeekly.data>();
    for (const row of cardRepoWeekly.data ?? []) {
      const key = row.login.toLowerCase();
      const list = rowsByLogin.get(key);
      if (list) list.push(row);
      else rowsByLogin.set(key, [row]);
    }
    const out = new Map<string, ReturnType<typeof buildStacks>>();
    for (const [login, rows] of rowsByLogin) {
      out.set(
        login,
        buildStacks({
          rows: rows ?? [],
          weeks: visibleWeeks,
          weekOf: (r) => r.week,
          keyOf: (r) => String(r.repo_id),
          labelOf: (r) => r.full_name.split("/").pop() ?? r.full_name,
          valueOf: (r) => Number(r[metric] ?? 0),
        }),
      );
    }
    return out;
  }, [cardSplit, cardRepoWeekly.data, visibleWeeks, metric]);

  /** One shared scale across the cards — self-scaled small multiples mislead. */
  const cardYMax = useMemo(
    () => Math.max(1, ...cards.slice(0, limit).flatMap((c) => c.weeks.map((w) => w.value))),
    [cards, limit],
  );

  const grandTotal = cards.reduce((a, c) => a + c[metric], 0);
  const metricLabel = METRICS.find((m) => m.id === metric)!.label.toLowerCase();
  const loading = totals.isFetching || perLogin.isFetching;

  return (
    <PageShell
      title="Contributors"
      userFilter="full"
      subtitle={
        <>
          Contributions per week across{" "}
          <strong className="font-medium text-ink">{full(selectedRepoCount)}</strong>{" "}
          {selectedRepoCount === 1 ? "repository" : "repositories"}, excluding merge commits
          {scope.filteredByUser ? (
            <> — filtered to {full(scope.logins?.length ?? 0)} selected contributors</>
          ) : null}
        </>
      }
      filterExtra={
        <Dropdown label={`Contributions: ${METRICS.find((m) => m.id === metric)!.label}`} width={180} align="left">
          {(close) => (
            <div className="py-1">
              {METRICS.map((m) => (
                <DropdownRow
                  key={m.id}
                  selected={m.id === metric}
                  onClick={() => {
                    setMetric(m.id);
                    close();
                  }}
                >
                  {m.label}
                </DropdownRow>
              ))}
            </div>
          )}
        </Dropdown>
      }
    >
      <div className="flex flex-col gap-4">
        <ChartCard
          title={`${METRICS.find((m) => m.id === metric)!.label} over time`}
          subtitle={
            zoomed
              ? `Weekly from ${formatDate(visibleWeeks[0] * 1000)} to ${formatDate(
                  visibleWeeks[visibleWeeks.length - 1] * 1000 + WEEK_SECONDS * 1000 - 1,
                )} — drag the handles below to change the window`
              : `Weekly from ${formatDate(scope.range.fromWeek * 1000)} to ${formatDate(
                  scope.range.toWeek * 1000 + WEEK_SECONDS * 1000 - 1,
                )}`
          }
          loading={loading}
          actions={
            <>
              <Segmented<TimelineShape>
                ariaLabel="Chart shape"
                value={shape}
                onChange={(v) => persist("github-monitor.shape", v, setShape)}
                options={[
                  { value: "bar", label: "Bars" },
                  { value: "area", label: "Area" },
                  { value: "line", label: "Line" },
                ]}
              />
              <Segmented
                ariaLabel="Accumulation"
                value={cumulative ? "cumulative" : "per"}
                onChange={(v) =>
                  persist("github-monitor.cumulative", v === "cumulative", setCumulative)
                }
                options={[
                  { value: "per", label: "Per period" },
                  { value: "cumulative", label: "Cumulative" },
                ]}
              />
              <Dropdown
                label={`Period: ${GRANULARITIES.find((g) => g.id === granularity)!.label}`}
                width={160}
                align="right"
              >
                {(close) => (
                  <div className="py-1">
                    {GRANULARITIES.map((g) => (
                      <DropdownRow
                        key={g.id}
                        selected={g.id === granularity}
                        onClick={() => {
                          persist("github-monitor.granularity", g.id, setGranularity);
                          close();
                        }}
                      >
                        {g.label}
                      </DropdownRow>
                    ))}
                  </div>
                )}
              </Dropdown>
              <Dropdown
                label={`Break down: ${
                  breakdown === "none"
                    ? "None"
                    : breakdown === "contributor"
                      ? "Contributor"
                      : "Repository"
                }`}
                width={200}
                align="right"
              >
                {(close) => (
                  <div className="py-1">
                    {(
                      [
                        ["none", "None"],
                        ["contributor", "By contributor"],
                        ["repository", "By repository"],
                      ] as const
                    ).map(([id, label]) => (
                      <DropdownRow
                        key={id}
                        selected={breakdown === id}
                        onClick={() => {
                          setBreakdown(id);
                          close();
                        }}
                      >
                        {label}
                      </DropdownRow>
                    ))}
                  </div>
                )}
              </Dropdown>
              {breakdown !== "none" ? (
                <Segmented
                  ariaLabel="Stacking"
                  value={stacked ? "stacked" : "overlaid"}
                  onChange={(v) => persist("github-monitor.stacked", v === "stacked", setStacked)}
                  options={[
                    { value: "stacked", label: "Stacked" },
                    { value: "overlaid", label: "Overlaid" },
                  ]}
                />
              ) : null}
              {zoomed ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setBrush(null);
                    setPendingBrush(null);
                  }}
                  title="Show the whole period again"
                >
                  Reset zoom
                </Button>
              ) : null}
              <span className="mr-1 text-[12px] tabular text-ink-secondary">
                {full(grandTotal)} total
              </span>
            </>
          }
          table={
            <DataTable
              rows={masterSeries.filter((d) => d.value > 0)}
              maxHeight={320}
              rowKey={(r) => r.week}
              initialSort={{ key: "week", dir: "desc" }}
              columns={[
                {
                  key: "week",
                  header: "Week of",
                  render: (r) => formatDate(r.week * 1000),
                  sortValue: (r) => r.week,
                },
                {
                  key: "value",
                  header: METRICS.find((m) => m.id === metric)!.label,
                  align: "right",
                  render: (r) => full(r.value),
                  sortValue: (r) => r.value,
                },
              ]}
            />
          }
        >
          <TimelineArea
            data={orgChart.data}
            series={orgChart.series}
            shape={shape}
            stacked={stacked}
            height={260}
            valueLabel={metricLabel}
            labelOf={(week) => bucketLabel(week, granularity)}
            activeKeys={activeKeys}
            onToggleKey={toggleKey}
            withBrush={granularity === "week"}
            onBrushChange={(r) => setPendingBrush({ start: r.startIndex, end: r.endIndex })}
          />

        </ChartCard>

        {cards.length === 0 ? (
          <EmptyState
            title="No contributions in this period"
            body="Try a longer period, or widen the repository selection."
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12px] text-ink-secondary">
                {zoomed
                  ? `Cards cover the selected window (${full(visibleWeeks.length)} week${
                      visibleWeeks.length === 1 ? "" : "s"
                    }), so totals and ranking change with it.`
                  : "Cards cover the whole period."}
                {cardSplit === "repository" && cardRepoWeekly.isFetching ? " Loading splits…" : ""}
              </p>
              <Segmented
                ariaLabel="Split contributor charts"
                value={cardSplit}
                onChange={setSplit}
                options={[
                  { value: "none", label: "Total" },
                  { value: "repository", label: "By repository" },
                ]}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {cards.slice(0, limit).map((c, i) => (
                <ContributorCardView
                  key={c.login}
                  card={c}
                  rank={i + 1}
                  metric={metric}
                  yMax={cardYMax}
                  repoCount={repos.length}
                  repoStack={cardStacks?.get(c.login.toLowerCase()) ?? null}
                  view={{ shape, stacked, cumulative, granularity }}
                />
              ))}
            </div>

            {cards.length > limit ? (
              <div className="flex items-center justify-center gap-3">
                <span className="text-[12px] text-ink-secondary">
                  Showing {full(limit)} of {full(cards.length)} contributors
                </span>
                <Button onClick={() => setLimit((l) => l + 24)}>Show more</Button>
                <Button variant="ghost" onClick={() => setLimit(cards.length)}>
                  Show all
                </Button>
              </div>
            ) : null}

            <Card>
              <h2 className="mb-2 text-[15px] font-semibold text-ink">All contributors</h2>
              <DataTable
                rows={cards}
                maxHeight={420}
                rowKey={(r) => r.login}
                initialSort={{ key: metric, dir: "desc" }}
                columns={[
                  {
                    key: "login",
                    header: "Contributor",
                    render: (r) => r.login,
                    sortValue: (r) => r.login,
                  },
                  {
                    key: "commits",
                    header: "Commits",
                    align: "right",
                    render: (r) => full(r.commits),
                    sortValue: (r) => r.commits,
                  },
                  {
                    key: "additions",
                    header: "Additions",
                    align: "right",
                    render: (r) => full(r.additions),
                    sortValue: (r) => r.additions,
                  },
                  {
                    key: "deletions",
                    header: "Deletions",
                    align: "right",
                    render: (r) => full(r.deletions),
                    sortValue: (r) => r.deletions,
                  },
                ]}
              />
            </Card>
          </>
        )}
      </div>
    </PageShell>
  );
}

function ContributorCardView({
  card,
  rank,
  metric,
  yMax,
  repoCount,
  repoStack,
  view,
}: {
  card: ContributorCard;
  rank: number;
  metric: ContributionMetric;
  yMax: number;
  repoCount: number;
  /** Prepared by the page so one query serves every card, not one query each. */
  repoStack: ReturnType<typeof buildStacks> | null;
  /** The shared timeline view, so cards and the org chart never disagree. */
  view: {
    shape: TimelineShape;
    stacked: boolean;
    cumulative: boolean;
    granularity: Granularity;
  };
}) {
  const scope = useScope();
  const [expanded, setExpanded] = useState(false);

  /**
   * The card's data, put through the same roll-up and accumulation as the org
   * chart so the two always describe time the same way.
   *
   * A cumulative card drops the shared y scale: accumulated totals differ by an
   * order of magnitude between the top and bottom of the list, so a shared ceiling
   * would flatten everyone but the leader.
   */
  const { cardData, cardSeries } = useMemo(() => {
    const series = repoStack
      ? repoStack.series.map((sr) => ({ key: sr.key, label: sr.label, slot: sr.slot }))
      : [{ key: "value", label: metric, slot: 0 }];
    const keys = series.map((sr) => sr.key);
    const base: Array<Record<string, number>> = repoStack
      ? repoStack.data
      : card.weeks.map((w) => ({ week: w.week, value: w.value }));
    const rolled = rollUp(base, keys, view.granularity);
    return { cardData: view.cumulative ? toCumulative(rolled, keys) : rolled, cardSeries: series };
  }, [repoStack, card.weeks, metric, view.granularity, view.cumulative]);

  const breakdown = useScopedQuery(
    `contrib-repos-${card.login}`,
    scope,
    (db) =>
      contributorRepoBreakdown(db, card.login, scope.repoIds, scope.range.fromWeek, scope.range.toWeek),
    { enabled: scope.ready && expanded },
  );

  return (
    <Card>
      <div className="mb-2 flex items-start gap-2.5">
        {card.avatar ? (
          <img
            src={card.avatar}
            alt=""
            width={32}
            height={32}
            className="mt-0.5 shrink-0 rounded-full"
            loading="lazy"
          />
        ) : (
          <div className="mt-0.5 h-8 w-8 shrink-0 rounded-full" style={{ background: "var(--wash-strong)" }} />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <a
              href={card.url ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="truncate text-[13px] font-semibold text-accent hover:underline"
            >
              {card.login}
            </a>
            <span className="shrink-0 rounded border border-hairline-strong px-1 text-[10px] tabular text-ink-muted">
              #{rank}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[12px] tabular">
            <span className="text-ink">{full(card.commits)} commits</span>
            {/* Delta cues wear status ink and are labelled, never color alone. */}
            <span style={{ color: "var(--delta-up)" }}>{full(card.additions)} ++</span>
            <span style={{ color: "var(--delta-down)" }}>{full(card.deletions)} --</span>
          </div>
        </div>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-wash hover:text-ink"
          aria-expanded={expanded}
        >
          {expanded ? "Hide numbers" : "Numbers"}
        </button>
      </div>

      {view.shape === "bar" && !repoStack ? (
        // The plain bar sparkline stays for the unbroken case: it is denser and
        // needs no legend, which matters at two dozen cards on screen.
        <Sparkline
          data={cardData as Array<{ week: number; value: number }>}
          metricLabel={metric}
          yMax={view.cumulative ? undefined : yMax}
          height={72}
        />
      ) : (
        <TimelineArea
          data={cardData}
          series={cardSeries}
          shape={view.shape}
          stacked={view.stacked}
          height={96}
          valueLabel={metric}
          labelOf={(week) => bucketLabel(week, view.granularity)}
        />
      )}

      {expanded ? (
        <div className="mt-3 border-t border-hairline pt-2">
          <DataTable
            rows={breakdown.data ?? []}
            maxHeight={180}
            empty={breakdown.isFetching ? "Loading…" : "No commits in the selected repositories"}
            rowKey={(r) => r.full_name}
            columns={[
              {
                key: "repo",
                header: `Repository (of ${full(repoCount)})`,
                render: (r) => r.full_name,
              },
              {
                key: "commits",
                header: "Commits",
                align: "right",
                render: (r) => compact(Number(r.commits)),
                sortValue: (r) => Number(r.commits),
              },
              {
                key: "net",
                header: "Net lines",
                align: "right",
                render: (r) => {
                  const net = Number(r.additions) - Number(r.deletions);
                  return (
                    <span style={{ color: net >= 0 ? "var(--delta-up)" : "var(--delta-down)" }}>
                      {net >= 0 ? "+" : "−"}
                      {compact(Math.abs(net))}
                    </span>
                  );
                },
                sortValue: (r) => Number(r.additions) - Number(r.deletions),
              },
            ]}
          />
        </div>
      ) : null}
    </Card>
  );
}
