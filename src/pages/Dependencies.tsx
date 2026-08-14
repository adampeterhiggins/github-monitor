import { useScope, useScopedQuery } from "../lib/hooks";
import { dependabotAlertRows, dependencyDrift, dependencyTotals, topDependencies } from "../lib/db/queries";
import { PageShell } from "../components/PageShell";
import { RankedBars } from "../components/charts";
import { Callout, Card, CardHeader, ChartCard, DataTable, StatTile, full } from "../components/ui";

export function Dependencies() {
  const scope = useScope();

  const totals = useScopedQuery("dep-totals", scope, (db) => dependencyTotals(db, scope.repoIds));
  const top = useScopedQuery("dep-top", scope, (db) => topDependencies(db, scope.repoIds, 100));
  const drift = useScopedQuery("dep-drift", scope, (db) => dependencyDrift(db, scope.repoIds, 60));
  const alerts = useScopedQuery("dep-alerts", scope, (db) => dependabotAlertRows(db, scope.repoIds));

  const ecosystems = totals.data ?? [];
  const totalPackages = ecosystems.reduce((a, e) => a + Number(e.packages), 0);
  const shared = (top.data ?? []).filter((d) => Number(d.repos) > 1).length;
  const drifting = drift.data ?? [];
  const openAlerts = alerts.data ?? [];
  const critical = openAlerts.filter((a) => (a.severity ?? "").toLowerCase() === "critical").length;
  const high = openAlerts.filter((a) => (a.severity ?? "").toLowerCase() === "high").length;
  const driftingVulnerable = openAlerts.filter((a) => Number(a.drifting) === 1).length;
  const alertsByPackage = Object.values(
    openAlerts.reduce<Record<string, { name: string; value: number }>>((acc, a) => {
      const name = a.package ?? "unknown";
      acc[name] = acc[name] ?? { name, value: 0 };
      acc[name].value += 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);

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
          org-wide view earns its keep: it shows which packages are shared, where versions
          have drifted apart, and which of those also have an open Dependabot alert —
          none of which a single repository's page can tell you. Needs the
          <code className="mx-1 text-[12px]">security_events</code> scope for alerts.
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

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Open alerts" value={openAlerts.length} hint="Dependabot, currently open" />
          <StatTile label="Critical" value={critical} />
          <StatTile label="High" value={high} />
          <StatTile
            label="Also drifting"
            value={driftingVulnerable}
            hint="Vulnerable and pinned to more than one version"
          />
        </div>

        <ChartCard
          title="Open Dependabot alerts"
          subtitle="Joined to the SBOM so a vulnerable package that has also drifted is marked"
          loading={alerts.isFetching}
          table={
            <DataTable
              rows={openAlerts}
              maxHeight={420}
              empty="No open alerts cached. A sync with the security_events scope fills this in; without it the table stays empty rather than guessing."
              rowKey={(r) => `${r.repo_id}:${r.number}`}
              columns={[
                {
                  key: "severity",
                  header: "Severity",
                  render: (r) => r.severity ?? "—",
                  sortValue: (r) => r.severity ?? "",
                },
                {
                  key: "pkg",
                  header: "Package",
                  render: (r) => r.package ?? "—",
                  sortValue: (r) => r.package ?? "",
                },
                { key: "eco", header: "Ecosystem", render: (r) => r.ecosystem ?? "—" },
                {
                  key: "repo",
                  header: "Repository",
                  render: (r) => r.full_name,
                  sortValue: (r) => r.full_name,
                },
                {
                  key: "drift",
                  header: "Drift",
                  render: (r) => (Number(r.drifting) === 1 ? "Yes" : "—"),
                  sortValue: (r) => Number(r.drifting),
                },
                {
                  key: "summary",
                  header: "Advisory",
                  render: (r) => (
                    <span className="text-ink-secondary" data-selectable>
                      {r.ghsa_id ? `${r.ghsa_id} · ` : ""}
                      {r.summary ?? "—"}
                    </span>
                  ),
                },
              ]}
            />
          }
        >
          <RankedBars valueLabel="alerts" data={alertsByPackage} />
        </ChartCard>
      </div>
    </PageShell>
  );
}
