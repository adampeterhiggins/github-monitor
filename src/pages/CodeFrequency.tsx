import { useMemo } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import { codeFrequencyWeekly } from "../lib/db/queries";
import { axisWeeksFor, formatDate } from "../lib/agg/weeks";
import { PageShell } from "../components/PageShell";
import { DivergingWeekly, RankedBars } from "../components/charts";
import { ChartCard, DataTable, StatTile, full } from "../components/ui";

export function CodeFrequency() {
  const scope = useScope();

  const weekly = useScopedQuery("code-frequency", scope, (db) =>
    codeFrequencyWeekly(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek),
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
    const byWeek = new Map(weekly.data?.map((r) => [r.week, r]) ?? []);
    return axisWeeks.map((week) => ({
      week,
      additions: Number(byWeek.get(week)?.additions ?? 0),
      deletions: Number(byWeek.get(week)?.deletions ?? 0),
    }));
  }, [weekly.data, axisWeeks]);

  const additions = series.reduce((a, d) => a + d.additions, 0);
  const deletions = series.reduce((a, d) => a + d.deletions, 0);
  const net = additions - deletions;
  const churn = additions + deletions;
  const biggest = series.reduce(
    (best, d) => (d.additions + d.deletions > best.additions + best.deletions ? d : best),
    { week: 0, additions: 0, deletions: 0 },
  );

  return (
    <PageShell
      title="Code frequency"
      subtitle={`Lines added and removed each week across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      }`}
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Additions" value={additions} />
          <StatTile label="Deletions" value={deletions} />
          <StatTile
            label="Net change"
            value={`${net >= 0 ? "+" : "−"}${full(Math.abs(net))}`}
            hint={net >= 0 ? "Codebase grew" : "Codebase shrank"}
          />
          <StatTile label="Total churn" value={churn} hint="Additions plus deletions" />
        </div>

        <ChartCard
          title="Additions and deletions over time"
          subtitle={`Weekly from ${formatDate(scope.range.fromWeek * 1000)} to ${formatDate(
            scope.range.toWeek * 1000,
          )}`}
          loading={weekly.isFetching}
          actions={
            biggest.week ? (
              <span className="mr-1 text-[12px] text-ink-secondary">
                Largest week: {formatDate(biggest.week * 1000)}
              </span>
            ) : null
          }
          table={
            <DataTable
              rows={series.filter((d) => d.additions > 0 || d.deletions > 0)}
              maxHeight={340}
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
                {
                  key: "net",
                  header: "Net",
                  align: "right",
                  render: (r) => {
                    const n = r.additions - r.deletions;
                    return (
                      <span style={{ color: n >= 0 ? "var(--delta-up)" : "var(--delta-down)" }}>
                        {n >= 0 ? "+" : "−"}
                        {full(Math.abs(n))}
                      </span>
                    );
                  },
                  sortValue: (r) => r.additions - r.deletions,
                },
              ]}
            />
          }
        >
          <DivergingWeekly data={series} height={300} />
        </ChartCard>

        <ChartCard
          title="Busiest weeks by churn"
          subtitle="Top 12 weeks by additions plus deletions"
          loading={weekly.isFetching}
          table={
            <DataTable
              rows={[...series].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)).slice(0, 12)}
              rowKey={(r) => r.week}
              columns={[
                { key: "week", header: "Week of", render: (r) => formatDate(r.week * 1000) },
                {
                  key: "churn",
                  header: "Churn",
                  align: "right",
                  render: (r) => full(r.additions + r.deletions),
                  sortValue: (r) => r.additions + r.deletions,
                },
              ]}
            />
          }
        >
          <RankedBars
            valueLabel="lines changed"
            data={[...series]
              .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
              .slice(0, 12)
              .map((d) => ({
                name: formatDate(d.week * 1000),
                value: d.additions + d.deletions,
              }))}
          />
        </ChartCard>
      </div>
    </PageShell>
  );
}
