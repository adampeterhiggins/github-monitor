import { useMemo, useState } from "react";
import { useApp, type ContributionMetric } from "../lib/state/app";
import { useScope, useScopedQuery } from "../lib/hooks";
import {
  contributorRepoBreakdown,
  contributorWeeklyByLogin,
  contributorWeeklyTotals,
  listContributorMeta,
  type ContributorWeekRow,
} from "../lib/db/queries";
import { WEEK_SECONDS, axisWeeksFor, formatDate } from "../lib/agg/weeks";
import { PageShell } from "../components/PageShell";
import { Sparkline, WeeklyColumns } from "../components/charts";
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

  const totals = useScopedQuery("contrib-totals", scope, (db) =>
    contributorWeeklyTotals(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek),
  );

  const perLogin = useScopedQuery("contrib-by-login", scope, (db) =>
    contributorWeeklyByLogin(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek),
  );

  const meta = useScopedQuery("contrib-meta", scope, (db) => listContributorMeta(db), {
    staleTime: 10 * 60_000,
  });

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

  const cards = useMemo(() => {
    const metaByLogin = new Map(meta.data?.map((m) => [m.login, m]) ?? []);
    const grouped = new Map<string, ContributorWeekRow[]>();
    for (const row of perLogin.data ?? []) {
      const list = grouped.get(row.login);
      if (list) list.push(row);
      else grouped.set(row.login, [row]);
    }

    const out: ContributorCard[] = [];
    for (const [login, rows] of grouped) {
      const byWeek = new Map(rows.map((r) => [r.week, r]));
      const commits = rows.reduce((a, r) => a + Number(r.commits), 0);
      const additions = rows.reduce((a, r) => a + Number(r.additions), 0);
      const deletions = rows.reduce((a, r) => a + Number(r.deletions), 0);
      out.push({
        login,
        avatar: metaByLogin.get(login)?.avatar_url ?? null,
        url: metaByLogin.get(login)?.html_url ?? null,
        commits,
        additions,
        deletions,
        weeks: axisWeeks.map((week) => ({
          week,
          value: Number(byWeek.get(week)?.[metric] ?? 0),
        })),
      });
    }

    // Rank by the selected contribution type, as the repo-level page does.
    return out
      .filter((c) => c[metric] > 0)
      .sort((a, b) => b[metric] - a[metric]);
  }, [perLogin.data, meta.data, axisWeeks, metric]);

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
      subtitle={
        <>
          Contributions per week across{" "}
          <strong className="font-medium text-ink">{full(selectedRepoCount)}</strong>{" "}
          {selectedRepoCount === 1 ? "repository" : "repositories"}, excluding merge commits
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
          subtitle={`Weekly from ${formatDate(scope.range.fromWeek * 1000)} to ${formatDate(
            scope.range.toWeek * 1000 + WEEK_SECONDS * 1000 - 1,
          )}`}
          loading={loading}
          actions={
            <span className="mr-1 text-[12px] tabular text-ink-secondary">
              {full(grandTotal)} total
            </span>
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
          <WeeklyColumns data={masterSeries} metricLabel={metricLabel} height={240} withBrush />
        </ChartCard>

        {cards.length === 0 ? (
          <EmptyState
            title="No contributions in this period"
            body="Try a longer period, or widen the repository selection."
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {cards.slice(0, limit).map((c, i) => (
                <ContributorCardView
                  key={c.login}
                  card={c}
                  rank={i + 1}
                  metric={metric}
                  yMax={cardYMax}
                  repoCount={repos.length}
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
}: {
  card: ContributorCard;
  rank: number;
  metric: ContributionMetric;
  yMax: number;
  repoCount: number;
}) {
  const scope = useScope();
  const [expanded, setExpanded] = useState(false);

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
          {expanded ? "Hide repos" : "By repo"}
        </button>
      </div>

      <Sparkline data={card.weeks} metricLabel={metric} yMax={yMax} height={64} />

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
