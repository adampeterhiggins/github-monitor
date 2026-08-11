import { useScope, useScopedQuery } from "../lib/hooks";
import { dependencyDrift, dependencyTotals, topDependencies } from "../lib/db/queries";
import { PageShell } from "../components/PageShell";
import { RankedBars } from "../components/charts";
import { Callout, Card, CardHeader, ChartCard, DataTable, StatTile, full } from "../components/ui";

export function Dependencies() {
  const scope = useScope();

  const totals = useScopedQuery("dep-totals", scope, (db) => dependencyTotals(db, scope.repoIds));
  const top = useScopedQuery("dep-top", scope, (db) => topDependencies(db, scope.repoIds, 100));
  const drift = useScopedQuery("dep-drift", scope, (db) => dependencyDrift(db, scope.repoIds, 60));

  const ecosystems = totals.data ?? [];
  const totalPackages = ecosystems.reduce((a, e) => a + Number(e.packages), 0);
  const shared = (top.data ?? []).filter((d) => Number(d.repos) > 1).length;
  const drifting = drift.data ?? [];

  return (
    <PageShell
      title="Dependency graph"
      subtitle={`Dependencies across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      }`}
      userFilter="none"
    >
      <div className="flex flex-col gap-4">
        <Callout>
          Sourced from GitHub's dependency-graph SBOM per repository. Aggregating it is where an
          org-wide view earns its keep: it shows which packages are shared and where versions
          have drifted apart — neither of which a single repository's page can tell you.
        </Callout>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Distinct packages" value={totalPackages} />
          <StatTile label="Ecosystems" value={ecosystems.length} />
          <StatTile label="Shared across repos" value={shared} hint="Used by two or more" />
          <StatTile
            label="Version conflicts"
            value={drifting.length}
            hint="Same package, differing versions"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard
            title="Packages by ecosystem"
            loading={totals.isFetching}
            table={
              <DataTable
                rows={ecosystems}
                rowKey={(r) => r.ecosystem}
                columns={[
                  { key: "eco", header: "Ecosystem", render: (r) => r.ecosystem },
                  {
                    key: "packages",
                    header: "Packages",
                    align: "right",
                    render: (r) => full(Number(r.packages)),
                    sortValue: (r) => Number(r.packages),
                  },
                  {
                    key: "repos",
                    header: "Repositories",
                    align: "right",
                    render: (r) => full(Number(r.repos)),
                    sortValue: (r) => Number(r.repos),
                  },
                ]}
              />
            }
          >
            <RankedBars
              valueLabel="packages"
              data={ecosystems.map((e) => ({ name: e.ecosystem, value: Number(e.packages) }))}
            />
          </ChartCard>

          <ChartCard
            title="Most widely used packages"
            subtitle="By number of repositories depending on them"
            loading={top.isFetching}
            table={
              <DataTable
                rows={top.data ?? []}
                maxHeight={320}
                rowKey={(r) => `${r.ecosystem}:${r.package}`}
                initialSort={{ key: "repos", dir: "desc" }}
                columns={[
                  { key: "pkg", header: "Package", render: (r) => r.package, sortValue: (r) => r.package },
                  { key: "eco", header: "Ecosystem", render: (r) => r.ecosystem },
                  {
                    key: "repos",
                    header: "Repositories",
                    align: "right",
                    render: (r) => full(Number(r.repos)),
                    sortValue: (r) => Number(r.repos),
                  },
                  {
                    key: "versions",
                    header: "Distinct versions",
                    align: "right",
                    render: (r) => full(Number(r.versions)),
                    sortValue: (r) => Number(r.versions),
                  },
                ]}
              />
            }
          >
            <RankedBars
              valueLabel="repositories"
              data={(top.data ?? []).slice(0, 12).map((d) => ({
                name: d.package.length > 30 ? `${d.package.slice(0, 29)}…` : d.package,
                value: Number(d.repos),
              }))}
            />
          </ChartCard>
        </div>

        <Card>
          <CardHeader
            title="Version drift"
            subtitle="Packages pinned to more than one version across the selected repositories"
          />
          <DataTable
            rows={drifting}
            maxHeight={420}
            empty="No version conflicts among the selected repositories"
            rowKey={(r) => `${r.ecosystem}:${r.package}`}
            initialSort={{ key: "versions", dir: "desc" }}
            columns={[
              { key: "pkg", header: "Package", render: (r) => r.package, sortValue: (r) => r.package },
              { key: "eco", header: "Ecosystem", render: (r) => r.ecosystem },
              {
                key: "versions",
                header: "Versions",
                align: "right",
                render: (r) => full(Number(r.versions)),
                sortValue: (r) => Number(r.versions),
              },
              {
                key: "repos",
                header: "Repositories",
                align: "right",
                render: (r) => full(Number(r.repos)),
                sortValue: (r) => Number(r.repos),
              },
              {
                key: "list",
                header: "Which versions",
                render: (r) => (
                  <span className="text-ink-secondary" data-selectable>
                    {r.version_list?.split(",").slice(0, 6).join(", ")}
                    {(r.version_list?.split(",").length ?? 0) > 6 ? " …" : ""}
                  </span>
                ),
              },
            ]}
          />
        </Card>
      </div>
    </PageShell>
  );
}
