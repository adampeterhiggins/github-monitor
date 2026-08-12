import { useEffect, useMemo, useState } from "react";
import { useApp, type ContributionMetric } from "../lib/state/app";
import { useScope, useScopedQuery } from "../lib/hooks";
import {
  contributorRepoBreakdown,
  contributorWeeklyByLogin,
  contributorWeeklyByRepo,
  contributorWeeklyTotals,
  listContributorMeta,
  weeklyByRepo,
  type ContributorWeekRow,
} from "../lib/db/queries";
import { buildStacks } from "../lib/agg/stacks";
import { WEEK_SECONDS, axisWeeksFor, formatDate } from "../lib/agg/weeks";
import { PageShell } from "../components/PageShell";
import { Sparkline, StackedSparkline, StackedWeeklyColumns, WeeklyColumns } from "../components/charts";
import {
  Button,
  ChartCard,
  Card,
  DataTable,
  Dropdown,
  DropdownRow,
  EmptyState,
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
        // The owner prefix is the same for every row here and just costs width.
        labelOf: (r) => r.full_name.split("/").pop() ?? r.full_name,
        valueOf: (r) => Number(r[metric] ?? 0),
      });
    }
    return null;
  }, [breakdown, perLogin.data, byRepoWeekly.data, visibleWeeks, metric]);

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
          {orgStack ? (
            <StackedWeeklyColumns
              data={orgStack.data}
              series={orgStack.series}
              metricLabel={metricLabel}
              height={240}
              withBrush
              onBrushChange={(r) => setPendingBrush({ start: r.startIndex, end: r.endIndex })}
            />
          ) : (
            <WeeklyColumns
              data={masterSeries}
              metricLabel={metricLabel}
              height={240}
              withBrush
              onBrushChange={(r) => setPendingBrush({ start: r.startIndex, end: r.endIndex })}
            />
          )}
        </ChartCard>

        {cards.length === 0 ? (
          <EmptyState
            title="No contributions in this period"
            body="Try a longer period, or widen the repository selection."
          />
        ) : (
          <>
            {zoomed ? (
              <p className="text-[12px] text-ink-secondary">
                Cards below cover the selected window ({full(visibleWeeks.length)} week
                {visibleWeeks.length === 1 ? "" : "s"}), so totals and ranking change with it.
              </p>
            ) : null}

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {cards.slice(0, limit).map((c, i) => (
                <ContributorCardView
                  key={c.login}
                  card={c}
                  rank={i + 1}
                  metric={metric}
                  yMax={cardYMax}
                  repoCount={repos.length}
                  weeks={visibleWeeks}
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
  weeks,
}: {
  card: ContributorCard;
  rank: number;
  metric: ContributionMetric;
  yMax: number;
  repoCount: number;
  /** The window the card covers, so its stack lines up with the sparkline. */
  weeks: number[];
}) {
  const scope = useScope();
  const [expanded, setExpanded] = useState(false);

  const repoWeekly = useScopedQuery(
    `contrib-repo-weekly-${card.login}`,
    scope,
    (db) =>
      contributorWeeklyByRepo(db, card.login, scope.repoIds, scope.range.fromWeek, scope.range.toWeek),
    { enabled: scope.ready && expanded },
  );

  const repoStack = useMemo(() => {
    if (!expanded || !repoWeekly.data) return null;
    return buildStacks({
      rows: repoWeekly.data,
      weeks,
      weekOf: (r) => r.week,
      keyOf: (r) => String(r.repo_id),
      labelOf: (r) => r.full_name.split("/").pop() ?? r.full_name,
      valueOf: (r) => Number(r[metric] ?? 0),
    });
  }, [expanded, repoWeekly.data, weeks, metric]);

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
          {expanded ? "Hide repos" : "Split by repo"}
        </button>
      </div>

      {repoStack && repoStack.series.length > 0 ? (
        <StackedSparkline
          data={repoStack.data}
          series={repoStack.series}
          metricLabel={metric}
          yMax={yMax}
          height={72}
        />
      ) : (
        <Sparkline data={card.weeks} metricLabel={metric} yMax={yMax} height={72} />
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
