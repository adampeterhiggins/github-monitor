import { useScope, useScopedQuery } from "../lib/hooks";
import { branchCounts, forkRows } from "../lib/db/queries";
import { PageShell } from "../components/PageShell";
import { RankedBars } from "../components/charts";
import { Callout, Card, CardHeader, ChartCard, DataTable, StatTile, full } from "../components/ui";

/**
 * GitHub's Network page draws a commit graph for one repository. That visual does
 * not aggregate — 80 overlaid commit graphs is noise — so the org-wide equivalent
 * is branch and fork topology: how much parallel work each repository carries.
 */
export function Network() {
  const scope = useScope();

  const branches = useScopedQuery("branch-counts", scope, (db) => branchCounts(db, scope.repoIds));
  const forks = useScopedQuery("network-forks", scope, (db) => forkRows(db, scope.repoIds));

  const rows = branches.data ?? [];
  const totalBranches = rows.reduce((a, r) => a + Number(r.branches), 0);
  const totalProtected = rows.reduce((a, r) => a + Number(r.protected_branches ?? 0), 0);
  const unprotected = rows.filter((r) => Number(r.protected_branches ?? 0) === 0).length;

  return (
    <PageShell
      title="Network"
      subtitle={`Branch and fork topology across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      }`}
    >
      <div className="flex flex-col gap-4">
        <Callout>
          GitHub's Network view is a per-repository commit graph, which does not aggregate
          meaningfully — overlaying dozens of them would be unreadable. This page shows the
          org-wide equivalent instead: where parallel work and forks are concentrated.
        </Callout>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Branches" value={totalBranches} hint="Across selected repositories" />
          <StatTile label="Protected branches" value={totalProtected} />
          <StatTile label="Repos with no protection" value={unprotected} />
          <StatTile label="Forks" value={(forks.data ?? []).length} />
        </div>

        <ChartCard
          title="Branch count by repository"
          subtitle="Top 15 — a proxy for how much work is in flight"
          loading={branches.isFetching}
          table={
            <DataTable
              rows={rows}
              maxHeight={340}
              rowKey={(r) => r.id}
              initialSort={{ key: "branches", dir: "desc" }}
              columns={[
                { key: "repo", header: "Repository", render: (r) => r.full_name, sortValue: (r) => r.full_name },
                { key: "default", header: "Default branch", render: (r) => r.default_branch ?? "—" },
                {
                  key: "branches",
                  header: "Branches",
                  align: "right",
                  render: (r) => full(Number(r.branches)),
                  sortValue: (r) => Number(r.branches),
                },
                {
                  key: "protected_branches",
                  header: "Protected",
                  align: "right",
                  render: (r) => full(Number(r.protected_branches ?? 0)),
                  sortValue: (r) => Number(r.protected_branches ?? 0),
                },
              ]}
            />
          }
        >
          <RankedBars
            valueLabel="branches"
            data={[...rows]
              .sort((a, b) => Number(b.branches) - Number(a.branches))
              .slice(0, 15)
              .map((r) => ({
                name: r.full_name.split("/").pop() ?? r.full_name,
                value: Number(r.branches),
              }))}
          />
        </ChartCard>

        <Card>
          <CardHeader title="Branch protection" subtitle="Every selected repository" />
          <DataTable
            rows={rows}
            maxHeight={420}
            rowKey={(r) => r.id}
            initialSort={{ key: "branches", dir: "desc" }}
            columns={[
              { key: "repo", header: "Repository", render: (r) => r.full_name, sortValue: (r) => r.full_name },
              {
                key: "branches",
                header: "Branches",
                align: "right",
                render: (r) => full(Number(r.branches)),
                sortValue: (r) => Number(r.branches),
              },
              {
                key: "status",
                header: "Protection",
                render: (r) =>
                  Number(r.protected_branches ?? 0) > 0 ? (
                    <span style={{ color: "var(--status-good)" }}>
                      ● {full(Number(r.protected_branches))} protected
                    </span>
                  ) : (
                    <span style={{ color: "var(--status-warning)" }}>◆ none protected</span>
                  ),
                sortValue: (r) => Number(r.protected_branches ?? 0),
              },
            ]}
          />
        </Card>
      </div>
    </PageShell>
  );
}
