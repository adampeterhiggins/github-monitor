import { useMemo } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import { punchcardTotals } from "../lib/db/queries";
import { PageShell } from "../components/PageShell";
import { GroupedColumns, PunchCard } from "../components/charts";
import { Callout, ChartCard, DataTable, StatTile, full } from "../components/ui";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function PunchCardPage() {
  const scope = useScope();

  const cells = useScopedQuery("punchcard", scope, (db) => punchcardTotals(db, scope.repoIds));

  const data = useMemo(
    () => (cells.data ?? []).map((c) => ({ dow: c.dow, hour: c.hour, commits: Number(c.commits) })),
    [cells.data],
  );

  const byHour = useMemo(() => {
    const totals = Array.from({ length: 24 }, () => 0);
    for (const c of data) totals[c.hour] += c.commits;
    return totals.map((commits, hour) => ({ name: String(hour).padStart(2, "0"), commits }));
  }, [data]);

  const byDay = useMemo(() => {
    const totals = Array.from({ length: 7 }, () => 0);
    for (const c of data) totals[c.dow] += c.commits;
    return DAY_NAMES.map((name, i) => ({ name: name.slice(0, 3), commits: totals[i], full: name }));
  }, [data]);

  const total = data.reduce((a, c) => a + c.commits, 0);
  const peak = data.reduce((best, c) => (c.commits > best.commits ? c : best), { dow: 0, hour: 0, commits: 0 });
  const weekendCommits = byDay[0].commits + byDay[6].commits;
  const officeHours = data
    .filter((c) => c.dow >= 1 && c.dow <= 5 && c.hour >= 9 && c.hour < 18)
    .reduce((a, c) => a + c.commits, 0);

  return (
    <PageShell
      title="Punch card"
      subtitle={`When commits land across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      }`}
    >
      <div className="flex flex-col gap-4">
        <Callout>
          GitHub's punch-card endpoint returns all-time totals with no date dimension, so this
          page ignores the period filter. The repository filter still applies. Hours are UTC.
        </Callout>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Commits" value={total} hint="All time" />
          <StatTile
            label="Peak hour"
            value={`${DAY_NAMES[peak.dow].slice(0, 3)} ${String(peak.hour).padStart(2, "0")}:00`}
            hint={`${full(peak.commits)} commits`}
          />
          <StatTile
            label="Weekend share"
            value={total ? `${Math.round((weekendCommits / total) * 100)}%` : "—"}
            hint="Saturday and Sunday"
          />
          <StatTile
            label="Within 09:00–18:00"
            value={total ? `${Math.round((officeHours / total) * 100)}%` : "—"}
            hint="Weekdays, UTC"
          />
        </div>

        <ChartCard
          title="Commits by day and hour"
          subtitle="Darker cells carry more commits; empty cells have none"
          loading={cells.isFetching}
          table={
            <DataTable
              rows={[...data].sort((a, b) => b.commits - a.commits).slice(0, 100)}
              maxHeight={360}
              rowKey={(r) => `${r.dow}-${r.hour}`}
              columns={[
                { key: "day", header: "Day", render: (r) => DAY_NAMES[r.dow] },
                {
                  key: "hour",
                  header: "Hour (UTC)",
                  render: (r) => `${String(r.hour).padStart(2, "0")}:00`,
                },
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
        >
          <PunchCard cells={data} />
        </ChartCard>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard
            title="Commits by hour"
            subtitle="Summed across every day, UTC"
            loading={cells.isFetching}
            table={
              <DataTable
                rows={byHour}
                maxHeight={300}
                rowKey={(r) => r.name}
                columns={[
                  { key: "hour", header: "Hour (UTC)", render: (r) => `${r.name}:00` },
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
          >
            <GroupedColumns
              data={byHour}
              series={[{ key: "commits", label: "Commits", slot: 0 }]}
              height={220}
            />
          </ChartCard>

          <ChartCard
            title="Commits by day"
            loading={cells.isFetching}
            table={
              <DataTable
                rows={byDay}
                rowKey={(r) => r.name}
                columns={[
                  { key: "day", header: "Day", render: (r) => r.full },
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
          >
            <GroupedColumns
              data={byDay}
              series={[{ key: "commits", label: "Commits", slot: 0 }]}
              height={220}
            />
          </ChartCard>
        </div>
      </div>
    </PageShell>
  );
}
