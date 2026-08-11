import { useMemo } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import { commitActivityDaily, commitsByRepo, contributorWeeklyTotals } from "../lib/db/queries";
import { WEEK_SECONDS, axisWeeksFor, formatDate } from "../lib/agg/weeks";
import { PageShell } from "../components/PageShell";
import { GroupedColumns, RankedBars, WeeklyColumns } from "../components/charts";
import { Card, CardHeader, ChartCard, DataTable, StatTile, full } from "../components/ui";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function Commits() {
  const scope = useScope();

  const weekly = useScopedQuery("commits-weekly", scope, (db) =>
    contributorWeeklyTotals(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek, scope.logins),
  );

  // `commit_activity` has no contributor dimension, so this one stays unfiltered.
  const daily = useScopedQuery("commits-daily", scope, (db) =>
    commitActivityDaily(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek),
  );

  const byRepo = useScopedQuery("commits-by-repo", scope, (db) =>
    commitsByRepo(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek, scope.logins),
  );

  const axisWeeks = useMemo(
    () =>
      axisWeeksFor(
        scope.range.fromWeek,
        scope.range.toWeek,
        (weekly.data ?? []).map((r) => r.week),
      ),
    [scope.range.fromWeek, scope.range.toWeek, weekly.data],
  );

  const series = useMemo(() => {
    const byWeek = new Map(weekly.data?.map((r) => [r.week, Number(r.commits)]) ?? []);
    return axisWeeks.map((week) => ({ week, value: byWeek.get(week) ?? 0 }));
  }, [weekly.data, axisWeeks]);

  const dayOfWeek = useMemo(() => {
    const totals = Array.from({ length: 7 }, () => 0);
    for (const row of daily.data ?? []) totals[row.dow] += Number(row.commits);
    return DAY_NAMES.map((name, i) => ({ name: name.slice(0, 3), commits: totals[i] }));
  }, [daily.data]);

  const total = series.reduce((a, d) => a + d.value, 0);
  const activeWeeks = series.filter((d) => d.value > 0).length;
  const busiest = series.reduce((best, d) => (d.value > best.value ? d : best), { week: 0, value: 0 });
  const busiestDay = dayOfWeek.reduce(
    (best, d) => (d.commits > best.commits ? d : best),
    { name: "—", commits: 0 },
  );

  // `commit_activity` only covers the last 52 weeks, unlike the contributor series.
  const dayDataTruncated =
    scope.range.fromWeek < Math.floor(Date.now() / 1000) - 52 * WEEK_SECONDS;

  return (
    <PageShell
      title="Commits"
      subtitle={`Commit volume across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      }`}
      userFilter="partial"
      partialUserNote={
        <>
          The contributor filter applies to <strong>Commits over time</strong>, the stat tiles and
          the repository breakdowns. It does <strong>not</strong> apply to{" "}
          <strong>Commits by day of week</strong>: that comes from GitHub's{" "}
          <code>commit_activity</code> endpoint, which reports totals per day with no
          per-contributor breakdown. That chart continues to show all contributors.
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Commits" value={total} hint="Default branch, excluding merges" />
          <StatTile label="Active weeks" value={activeWeeks} hint={`of ${full(series.length)} in range`} />
          <StatTile
            label="Busiest week"
            value={busiest.value}
            hint={busiest.week ? `Week of ${formatDate(busiest.week * 1000)}` : "—"}
          />
          <StatTile
            label="Weekly average"
            value={activeWeeks ? Math.round(total / series.length) : 0}
            hint="Across all weeks in range"
          />
        </div>

        <ChartCard
          title="Commits over time"
          subtitle={`Weekly from ${formatDate(scope.range.fromWeek * 1000)} to ${formatDate(
            scope.range.toWeek * 1000,
          )}`}
          loading={weekly.isFetching}
          table={
            <DataTable
              rows={series.filter((d) => d.value > 0)}
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
                  header: "Commits",
                  align: "right",
                  render: (r) => full(r.value),
                  sortValue: (r) => r.value,
                },
              ]}
            />
          }
        >
          <WeeklyColumns data={series} metricLabel="commits" height={260} withBrush />
        </ChartCard>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard
            title="Commits by day of week"
            subtitle={
              scope.filteredByUser
                ? "All contributors — GitHub supplies no per-contributor day breakdown"
                : dayDataTruncated
                  ? "GitHub supplies day-level detail for the last 52 weeks only"
                  : "Summed across the selected period"
            }
            loading={daily.isFetching}
            table={
              <DataTable
                rows={dayOfWeek}
                rowKey={(r) => r.name}
                columns={[
                  { key: "day", header: "Day", render: (r) => r.name },
                  {
                    key: "commits",
                    header: "Commits",
                    align: "right",
                    render: (r) => full(r.commits),
                    sortValue: (r) => r.commits,
                  },
                ]}
              />
            }
            actions={
              <span className="mr-1 text-[12px] text-ink-secondary">
                Peak: {busiestDay.name}
              </span>
            }
          >
            <GroupedColumns
              data={dayOfWeek}
              series={[{ key: "commits", label: "Commits", slot: 0 }]}
              height={220}
            />
          </ChartCard>

          <ChartCard
            title="Commits by repository"
            subtitle="Top 12 in the selected period"
            loading={byRepo.isFetching}
            table={
              <DataTable
                rows={byRepo.data ?? []}
                maxHeight={260}
                rowKey={(r) => r.id}
                initialSort={{ key: "commits", dir: "desc" }}
                columns={[
                  { key: "repo", header: "Repository", render: (r) => r.full_name },
                  {
                    key: "commits",
                    header: "Commits",
                    align: "right",
                    render: (r) => full(Number(r.commits)),
                    sortValue: (r) => Number(r.commits),
                  },
                  {
                    key: "additions",
                    header: "Additions",
                    align: "right",
                    render: (r) => full(Number(r.additions)),
                    sortValue: (r) => Number(r.additions),
                  },
                  {
                    key: "deletions",
                    header: "Deletions",
                    align: "right",
                    render: (r) => full(Number(r.deletions)),
                    sortValue: (r) => Number(r.deletions),
                  },
                ]}
              />
            }
          >
            <RankedBars
              valueLabel="commits"
              data={(byRepo.data ?? []).slice(0, 12).map((r) => ({
                name: r.full_name.split("/").pop() ?? r.full_name,
                value: Number(r.commits),
              }))}
            />
          </ChartCard>
        </div>

        <Card>
          <CardHeader
            title="Repository totals"
            subtitle="Every selected repository with activity in this period"
          />
          <DataTable
            rows={byRepo.data ?? []}
            maxHeight={420}
            rowKey={(r) => r.id}
            initialSort={{ key: "commits", dir: "desc" }}
            columns={[
              { key: "repo", header: "Repository", render: (r) => r.full_name, sortValue: (r) => r.full_name },
              {
                key: "commits",
                header: "Commits",
                align: "right",
                render: (r) => full(Number(r.commits)),
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
                      {full(Math.abs(net))}
                    </span>
                  );
                },
                sortValue: (r) => Number(r.additions) - Number(r.deletions),
              },
            ]}
          />
        </Card>
      </div>
    </PageShell>
  );
}
