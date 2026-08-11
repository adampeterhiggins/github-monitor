import { useMemo } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import { topTrafficPaths, topTrafficReferrers, trafficByRepo, trafficDaily } from "../lib/db/queries";
import { useApp } from "../lib/state/app";
import { PageShell } from "../components/PageShell";
import { DailyArea, RankedBars } from "../components/charts";
import { Callout, Card, CardHeader, ChartCard, DataTable, StatTile, full } from "../components/ui";

export function Traffic() {
  const scope = useScope();
  const repos = useApp((s) => s.repos);

  const daily = useScopedQuery("traffic-daily", scope, (db) =>
    trafficDaily(db, scope.repoIds, scope.fromDay, scope.toDay),
  );
  const byRepo = useScopedQuery("traffic-by-repo", scope, (db) =>
    trafficByRepo(db, scope.repoIds, scope.fromDay, scope.toDay),
  );
  const paths = useScopedQuery("traffic-paths", scope, (db) => topTrafficPaths(db, scope.repoIds));
  const referrers = useScopedQuery("traffic-referrers", scope, (db) =>
    topTrafficReferrers(db, scope.repoIds),
  );

  const series = useMemo(() => {
    const byDay = new Map<string, { day: string; views: number; clones: number }>();
    for (const row of daily.data ?? []) {
      const entry = byDay.get(row.day) ?? { day: row.day, views: 0, clones: 0 };
      if (row.kind === "view") entry.views += Number(row.count);
      else entry.clones += Number(row.count);
      byDay.set(row.day, entry);
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  }, [daily.data]);

  const totals = (byRepo.data ?? []).reduce(
    (acc, r) => ({
      views: acc.views + Number(r.views),
      viewUniques: acc.viewUniques + Number(r.view_uniques),
      clones: acc.clones + Number(r.clones),
      cloneUniques: acc.cloneUniques + Number(r.clone_uniques),
    }),
    { views: 0, viewUniques: 0, clones: 0, cloneUniques: 0 },
  );

  const noPushAccess = repos.filter((r) => scope.repoIds.includes(r.id) && r.can_push === 0).length;

  return (
    <PageShell
      title="Traffic"
      subtitle={`Views and clones across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      }`}
    >
      <div className="flex flex-col gap-4">
        <Callout tone={series.length === 0 ? "warning" : "info"}>
          GitHub only serves the last 14 days of traffic and requires push access to each
          repository. This app appends every sync to a local table, so history builds up beyond
          14 days from your first sync onwards — but nothing before it can be recovered.
          {noPushAccess > 0
            ? ` ${full(noPushAccess)} selected ${
                noPushAccess === 1 ? "repository is" : "repositories are"
              } excluded for lack of push access.`
            : ""}
        </Callout>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Views" value={totals.views} hint="Page views in range" />
          <StatTile label="Unique visitors" value={totals.viewUniques} />
          <StatTile label="Clones" value={totals.clones} />
          <StatTile label="Unique cloners" value={totals.cloneUniques} />
        </div>

        <ChartCard
          title="Views and clones over time"
          subtitle="Daily totals across the selected repositories"
          loading={daily.isFetching}
          table={
            <DataTable
              rows={series}
              maxHeight={320}
              rowKey={(r) => r.day}
              initialSort={{ key: "day", dir: "desc" }}
              columns={[
                { key: "day", header: "Day", render: (r) => r.day, sortValue: (r) => r.day },
                {
                  key: "views",
                  header: "Views",
                  align: "right",
                  render: (r) => full(r.views),
                  sortValue: (r) => r.views,
                },
                {
                  key: "clones",
                  header: "Clones",
                  align: "right",
                  render: (r) => full(r.clones),
                  sortValue: (r) => r.clones,
                },
              ]}
            />
          }
        >
          <DailyArea
            data={series}
            series={[
              { key: "views", label: "Views", slot: 0 },
              { key: "clones", label: "Clones", slot: 1 },
            ]}
            height={260}
          />
        </ChartCard>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard
            title="Top referrers"
            subtitle="Most recent snapshot per repository"
            loading={referrers.isFetching}
            table={
              <DataTable
                rows={referrers.data ?? []}
                maxHeight={300}
                rowKey={(r) => r.referrer}
                columns={[
                  { key: "referrer", header: "Referrer", render: (r) => r.referrer },
                  {
                    key: "count",
                    header: "Views",
                    align: "right",
                    render: (r) => full(Number(r.count)),
                    sortValue: (r) => Number(r.count),
                  },
                  {
                    key: "uniques",
                    header: "Uniques",
                    align: "right",
                    render: (r) => full(Number(r.uniques)),
                    sortValue: (r) => Number(r.uniques),
                  },
                ]}
              />
            }
          >
            <RankedBars
              valueLabel="views"
              data={(referrers.data ?? []).slice(0, 10).map((r) => ({
                name: r.referrer,
                value: Number(r.count),
              }))}
            />
          </ChartCard>

          <ChartCard
            title="Most visited paths"
            subtitle="Most recent snapshot per repository"
            loading={paths.isFetching}
            table={
              <DataTable
                rows={paths.data ?? []}
                maxHeight={300}
                rowKey={(r) => r.path}
                columns={[
                  { key: "path", header: "Path", render: (r) => r.title || r.path },
                  {
                    key: "count",
                    header: "Views",
                    align: "right",
                    render: (r) => full(Number(r.count)),
                    sortValue: (r) => Number(r.count),
                  },
                ]}
              />
            }
          >
            <RankedBars
              valueLabel="views"
              data={(paths.data ?? []).slice(0, 10).map((r) => ({
                name: (r.path.split("/").slice(-2).join("/") || r.path).slice(0, 34),
                value: Number(r.count),
              }))}
            />
          </ChartCard>
        </div>

        <Card>
          <CardHeader title="Per-repository traffic" subtitle="Summed over the selected period" />
          <DataTable
            rows={byRepo.data ?? []}
            maxHeight={420}
            empty="No traffic data cached. Traffic requires push access and a completed sync."
            rowKey={(r) => r.full_name}
            initialSort={{ key: "views", dir: "desc" }}
            columns={[
              { key: "repo", header: "Repository", render: (r) => r.full_name, sortValue: (r) => r.full_name },
              {
                key: "views",
                header: "Views",
                align: "right",
                render: (r) => full(Number(r.views)),
                sortValue: (r) => Number(r.views),
              },
              {
                key: "view_uniques",
                header: "Unique visitors",
                align: "right",
                render: (r) => full(Number(r.view_uniques)),
                sortValue: (r) => Number(r.view_uniques),
              },
              {
                key: "clones",
                header: "Clones",
                align: "right",
                render: (r) => full(Number(r.clones)),
                sortValue: (r) => Number(r.clones),
              },
              {
                key: "clone_uniques",
                header: "Unique cloners",
                align: "right",
                render: (r) => full(Number(r.clone_uniques)),
                sortValue: (r) => Number(r.clone_uniques),
              },
            ]}
          />
        </Card>
      </div>
    </PageShell>
  );
}
