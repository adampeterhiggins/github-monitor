import { useMemo } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import { forkRows } from "../lib/db/queries";
import { formatDate } from "../lib/agg/weeks";
import { PageShell } from "../components/PageShell";
import { RankedBars } from "../components/charts";
import { Card, CardHeader, ChartCard, DataTable, StatTile, full } from "../components/ui";

export function Forks() {
  const scope = useScope();
  const forks = useScopedQuery("forks", scope, (db) => forkRows(db, scope.repoIds));

  const rows = forks.data ?? [];

  const byParent = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of rows) map.set(f.parent, (map.get(f.parent) ?? 0) + 1);
    return [...map.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [rows]);

  const activeCutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const active = rows.filter((f) => (f.pushed_at ?? "") >= activeCutoff).length;
  const uniqueOwners = new Set(rows.map((f) => f.owner_login)).size;

  return (
    <PageShell
      title="Forks"
      subtitle={`Forks of ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      }`}
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Forks" value={rows.length} />
          <StatTile label="Distinct owners" value={uniqueOwners} />
          <StatTile label="Pushed in last 90 days" value={active} hint="Forks with recent activity" />
          <StatTile label="Repositories forked" value={byParent.length} />
        </div>

        <ChartCard
          title="Forks by repository"
          subtitle="Which repositories attract forks"
          loading={forks.isFetching}
          table={
            <DataTable
              rows={byParent}
              maxHeight={300}
              rowKey={(r) => r.name}
              columns={[
                { key: "repo", header: "Repository", render: (r) => r.name },
                {
                  key: "forks",
                  header: "Forks",
                  align: "right",
                  render: (r) => full(r.value),
                  sortValue: (r) => r.value,
                },
              ]}
            />
          }
        >
          <RankedBars
            valueLabel="forks"
            data={byParent.slice(0, 15).map((p) => ({
              name: p.name.split("/").pop() ?? p.name,
              value: p.value,
            }))}
          />
        </ChartCard>

        <Card>
          <CardHeader title="All forks" subtitle="Newest first" />
          <DataTable
            rows={rows}
            maxHeight={480}
            empty="No forks of the selected repositories"
            rowKey={(r, i) => `${r.full_name}:${i}`}
            initialSort={{ key: "created", dir: "desc" }}
            columns={[
              {
                key: "fork",
                header: "Fork",
                render: (r) => (
                  <a
                    href={r.html_url ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent hover:underline"
                  >
                    {r.full_name}
                  </a>
                ),
                sortValue: (r) => r.full_name,
              },
              { key: "parent", header: "Forked from", render: (r) => r.parent, sortValue: (r) => r.parent },
              {
                key: "created",
                header: "Created",
                render: (r) => (r.created_at ? formatDate(new Date(r.created_at)) : "—"),
                sortValue: (r) => r.created_at ?? "",
              },
              {
                key: "pushed",
                header: "Last push",
                render: (r) => (r.pushed_at ? formatDate(new Date(r.pushed_at)) : "never"),
                sortValue: (r) => r.pushed_at ?? "",
              },
              {
                key: "stars",
                header: "Stars",
                align: "right",
                render: (r) => full(Number(r.stars)),
                sortValue: (r) => Number(r.stars),
              },
            ]}
          />
        </Card>
      </div>
    </PageShell>
  );
}
