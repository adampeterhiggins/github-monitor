import { useMemo } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import { rosterRows } from "../lib/db/queries";
import { PERIODS, WEEK_SECONDS, axisWeeksFor, formatDate } from "../lib/agg/weeks";
import { useApp } from "../lib/state/app";
import { PageShell } from "../components/PageShell";
import { RankedBars, WeeklyColumns } from "../components/charts";
import { Callout, Card, CardHeader, ChartCard, DataTable, StatTile, full } from "../components/ui";

function weeksQuiet(lastWeek: number, toWeek: number): number {
  return Math.max(0, Math.round((toWeek - lastWeek) / WEEK_SECONDS));
}

export function Roster() {
  const scope = useScope();
  const period = useApp((s) => s.period);
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? "the selected period";

  const roster = useScopedQuery("roster", scope, (db) =>
    rosterRows(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek, scope.logins),
  );

  const rows = roster.data ?? [];
  const fromWeek = scope.range.fromWeek;
  const toWeek = scope.range.toWeek;

  const arrived = rows.filter((r) => Number(r.first_week) >= fromWeek && Number(r.first_week) <= toWeek);
  const quiet = rows.filter((r) => Number(r.last_week) < fromWeek);
  const active = rows.filter((r) => Number(r.commits) > 0);
  const leftCold = rows.filter((r) => Number(r.left_repos) > 0 && Number(r.last_week) < fromWeek);

  const arrivals = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of arrived) {
      const week = Number(r.first_week);
      counts.set(week, (counts.get(week) ?? 0) + 1);
    }
    return axisWeeksFor(
      fromWeek,
      toWeek,
      [...counts.keys()],
    ).map((week) => ({ week, value: counts.get(week) ?? 0 }));
  }, [arrived, fromWeek, toWeek]);

  const quietBars = [...quiet]
    .map((r) => ({
      name: r.login,
      value: weeksQuiet(Number(r.last_week), toWeek),
    }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, 12);

  return (
    <PageShell
      title="Roster"
      subtitle={`Who arrived and who went quiet across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      } — ${periodLabel.toLowerCase()}`}
      userFilter="full"
    >
      <Callout>
        GitHub will show one person's profile, or one repository's contributors.
        It will not show an organisation roster with last-seen dates. First and
        last week are the first and last Sunday buckets with commits in the
        selected repositories — the same series Ownership uses. A repository
        left cold is one whose most recent commit week is this person alone.
      </Callout>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Arrived" value={arrived.length} hint="First commit in this period" />
        <StatTile label="Quiet" value={quiet.length} hint="No commits in this period" />
        <StatTile label="Active" value={active.length} hint="Any commits in this period" />
        <StatTile
          label="Left a repo cold"
          value={leftCold.length}
          hint="Last sole committer, and quiet"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard
          title="Arrivals"
          subtitle="People whose first commit in these repositories falls in that week"
          loading={roster.isFetching}
          table={
            <DataTable
              rows={arrivals.filter((d) => d.value > 0)}
              maxHeight={300}
              empty="No first commits in this period"
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
                  key: "arrived",
                  header: "Arrived",
                  align: "right",
                  render: (r) => full(r.value),
                  sortValue: (r) => r.value,
                },
              ]}
            />
          }
        >
          <WeeklyColumns data={arrivals} metricLabel="arrived" height={240} />
        </ChartCard>

        <ChartCard
          title="Longest quiet"
          subtitle="Weeks since their last commit, among people with none in the period"
          loading={roster.isFetching}
          table={
            <DataTable
              rows={quiet}
              maxHeight={300}
              empty="Everyone in the cache committed in this period"
              rowKey={(r) => r.login}
              initialSort={{ key: "quiet", dir: "desc" }}
              columns={[
                { key: "login", header: "Contributor", render: (r) => r.login, sortValue: (r) => r.login },
                {
                  key: "last",
                  header: "Last seen",
                  render: (r) => formatDate(Number(r.last_week) * 1000),
                  sortValue: (r) => Number(r.last_week),
                },
                {
                  key: "quiet",
                  header: "Weeks quiet",
                  align: "right",
                  render: (r) => full(weeksQuiet(Number(r.last_week), toWeek)),
                  sortValue: (r) => weeksQuiet(Number(r.last_week), toWeek),
                },
                {
                  key: "left",
                  header: "Repos left cold",
                  align: "right",
                  render: (r) => full(Number(r.left_repos)),
                  sortValue: (r) => Number(r.left_repos),
                },
              ]}
            />
          }
        >
          <RankedBars data={quietBars} valueLabel="weeks quiet" />
        </ChartCard>
      </div>

      <Card>
        <CardHeader
          title="Everyone seen"
          subtitle={`${full(rows.length)} ${
            rows.length === 1 ? "person" : "people"
          } with any commits in the selected repositories`}
        />
        <DataTable
          rows={rows}
          maxHeight={480}
          empty="No contributors in this selection"
          rowKey={(r) => r.login}
          initialSort={{ key: "last", dir: "asc" }}
          columns={[
            { key: "login", header: "Contributor", render: (r) => r.login, sortValue: (r) => r.login },
            {
              key: "first",
              header: "First seen",
              render: (r) => formatDate(Number(r.first_week) * 1000),
              sortValue: (r) => Number(r.first_week),
            },
            {
              key: "last",
              header: "Last seen",
              render: (r) => formatDate(Number(r.last_week) * 1000),
              sortValue: (r) => Number(r.last_week),
            },
            {
              key: "quiet",
              header: "Weeks quiet",
              align: "right",
              render: (r) => full(weeksQuiet(Number(r.last_week), toWeek)),
              sortValue: (r) => weeksQuiet(Number(r.last_week), toWeek),
            },
            {
              key: "commits",
              header: "Commits in period",
              align: "right",
              render: (r) => full(Number(r.commits)),
              sortValue: (r) => Number(r.commits),
            },
            {
              key: "repos",
              header: "Repos in period",
              align: "right",
              render: (r) => full(Number(r.repos)),
              sortValue: (r) => Number(r.repos),
            },
            {
              key: "left",
              header: "Repos left cold",
              align: "right",
              render: (r) => full(Number(r.left_repos)),
              sortValue: (r) => Number(r.left_repos),
            },
          ]}
        />
      </Card>
    </PageShell>
  );
}
