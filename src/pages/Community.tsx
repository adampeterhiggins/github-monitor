import { useMemo } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import { communityRows, type CommunityRow } from "../lib/db/queries";
import { PageShell } from "../components/PageShell";
import { HeatMatrix, Meter, RankedBars } from "../components/charts";
import { ChartCard, DataTable, StatTile, full } from "../components/ui";

const CHECKS: Array<{ key: keyof CommunityRow; label: string; short: string }> = [
  { key: "has_desc", label: "Description", short: "Desc" },
  { key: "has_readme", label: "README", short: "README" },
  { key: "has_license", label: "Licence", short: "Licence" },
  { key: "has_contrib", label: "Contributing guide", short: "Contrib" },
  { key: "has_coc", label: "Code of conduct", short: "CoC" },
  { key: "has_issue_tpl", label: "Issue template", short: "Issue tpl" },
  { key: "has_pr_tpl", label: "Pull request template", short: "PR tpl" },
  { key: "has_security", label: "Security policy", short: "Security" },
];

export function Community() {
  const scope = useScope();
  const rows = useScopedQuery("community", scope, (db) => communityRows(db, scope.repoIds));

  const data = rows.data ?? [];

  const coverage = useMemo(
    () =>
      CHECKS.map((c) => ({
        name: c.label,
        value: data.filter((r) => Number(r[c.key]) === 1).length,
      })),
    [data],
  );

  const avgHealth = data.length
    ? Math.round(data.reduce((a, r) => a + Number(r.health), 0) / data.length)
    : 0;
  const fullyHealthy = data.filter((r) => Number(r.health) >= 80).length;
  const noReadme = data.filter((r) => Number(r.has_readme) === 0).length;
  const noLicence = data.filter((r) => Number(r.has_license) === 0).length;

  return (
    <PageShell
      title="Community"
      subtitle={`Community health across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      }`}
      userFilter="none"
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Average health" value={`${avgHealth}%`} hint="GitHub's own score" />
          <StatTile label="At 80% or above" value={fullyHealthy} hint={`of ${full(data.length)} repos`} />
          <StatTile label="Missing a README" value={noReadme} />
          <StatTile label="Missing a licence" value={noLicence} />
        </div>

        <ChartCard
          title="Checklist coverage"
          subtitle={`How many of the ${full(data.length)} selected repositories have each item`}
          loading={rows.isFetching}
          table={
            <DataTable
              rows={coverage}
              rowKey={(r) => r.name}
              columns={[
                { key: "item", header: "Item", render: (r) => r.name },
                {
                  key: "count",
                  header: "Repositories",
                  align: "right",
                  render: (r) => full(r.value),
                  sortValue: (r) => r.value,
                },
                {
                  key: "pct",
                  header: "Share",
                  align: "right",
                  render: (r) => (data.length ? `${Math.round((r.value / data.length) * 100)}%` : "—"),
                  sortValue: (r) => r.value,
                },
              ]}
            />
          }
        >
          <RankedBars valueLabel="repositories" data={coverage} />
        </ChartCard>

        <ChartCard
          title="Coverage matrix"
          subtitle="One row per repository, one column per checklist item — green is present"
          loading={rows.isFetching}
          table={
            <DataTable
              rows={data}
              maxHeight={520}
              rowKey={(r) => r.id}
              initialSort={{ key: "health", dir: "desc" }}
              columns={[
                {
                  key: "repo",
                  header: "Repository",
                  render: (r) => r.full_name,
                  sortValue: (r) => r.full_name,
                },
                {
                  key: "health",
                  header: "Health",
                  width: "150px",
                  render: (r) => <Meter value={Number(r.health)} />,
                  sortValue: (r) => Number(r.health),
                },
                ...CHECKS.map((c) => ({
                  key: String(c.key),
                  header: c.short,
                  align: "right" as const,
                  render: (r: CommunityRow) =>
                    Number(r[c.key]) === 1 ? (
                      <span aria-label={`${c.label}: present`} style={{ color: "var(--status-good)" }}>
                        ✓
                      </span>
                    ) : (
                      <span aria-label={`${c.label}: missing`} className="text-ink-muted">
                        —
                      </span>
                    ),
                  sortValue: (r: CommunityRow) => Number(r[c.key]),
                })),
              ]}
            />
          }
        >
          <HeatMatrix
            mode="binary"
            rowLabels={data.map((r) => r.full_name)}
            columnLabels={CHECKS.map((c) => c.short)}
            values={data.map((r) => CHECKS.map((c) => Number(r[c.key])))}
            format={(v, _r, c) => (v > 0 ? CHECKS[c].label : `Missing ${CHECKS[c].label}`)}
          />
        </ChartCard>
      </div>
    </PageShell>
  );
}
