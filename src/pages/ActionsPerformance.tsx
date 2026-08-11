import { useMemo } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import { workflowDurations } from "../lib/db/queries";
import { PageShell } from "../components/PageShell";
import { RankedBars } from "../components/charts";
import {
  Callout,
  Card,
  CardHeader,
  ChartCard,
  DataTable,
  StatTile,
  formatDuration,
  full,
} from "../components/ui";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

interface WorkflowStat {
  key: string;
  repo: string;
  workflow: string;
  runs: number;
  failures: number;
  p50: number;
  p90: number;
  p99: number;
  total: number;
}

export function ActionsPerformance() {
  const scope = useScope();

  const runs = useScopedQuery("actions-perf", scope, (db) =>
    workflowDurations(db, scope.repoIds, scope.fromIso, scope.toIso),
  );

  const stats = useMemo<WorkflowStat[]>(() => {
    const grouped = new Map<string, { repo: string; workflow: string; durations: number[]; failures: number }>();
    for (const r of runs.data ?? []) {
      const workflow = r.name ?? "(unnamed)";
      const key = `${r.full_name}::${workflow}`;
      const entry = grouped.get(key) ?? { repo: r.full_name, workflow, durations: [], failures: 0 };
      entry.durations.push(Number(r.duration_ms));
      if (r.conclusion === "failure") entry.failures += 1;
      grouped.set(key, entry);
    }

    return [...grouped.entries()]
      .map(([key, v]) => {
        const sorted = [...v.durations].sort((a, b) => a - b);
        return {
          key,
          repo: v.repo,
          workflow: v.workflow,
          runs: sorted.length,
          failures: v.failures,
          p50: percentile(sorted, 0.5),
          p90: percentile(sorted, 0.9),
          p99: percentile(sorted, 0.99),
          total: sorted.reduce((a, b) => a + b, 0),
        };
      })
      .sort((a, b) => b.p50 - a.p50);
  }, [runs.data]);

  const allDurations = useMemo(
    () => (runs.data ?? []).map((r) => Number(r.duration_ms)).sort((a, b) => a - b),
    [runs.data],
  );

  const totalRuns = allDurations.length;
  const totalFailures = stats.reduce((a, s) => a + s.failures, 0);

  // Slow *and* frequent is what actually costs time, so rank by aggregate spend.
  const costliest = useMemo(() => [...stats].sort((a, b) => b.total - a.total), [stats]);

  return (
    <PageShell
      title="Actions performance metrics"
      subtitle={`Workflow duration and reliability across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      }`}
      userFilter="none"
    >
      <div className="flex flex-col gap-4">
        <Callout>
          Durations are wall-clock elapsed time from run start to last update, computed from
          workflow-run records. Runs GitHub has not finished updating are excluded, and the sync
          caps at three pages of runs per repository.
        </Callout>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Runs measured" value={totalRuns} />
          <StatTile label="Median duration" value={formatDuration(percentile(allDurations, 0.5))} />
          <StatTile
            label="90th percentile"
            value={formatDuration(percentile(allDurations, 0.9))}
            hint="Slowest tenth"
          />
          <StatTile
            label="Failure rate"
            value={totalRuns ? `${Math.round((totalFailures / totalRuns) * 100)}%` : "—"}
            hint={`${full(totalFailures)} failed runs`}
          />
        </div>

        <ChartCard
          title="Slowest workflows"
          subtitle="Top 15 by median duration, in minutes"
          loading={runs.isFetching}
          table={
            <DataTable
              rows={stats}
              maxHeight={360}
              rowKey={(r) => r.key}
              initialSort={{ key: "p50", dir: "desc" }}
              columns={[
                { key: "workflow", header: "Workflow", render: (r) => r.workflow, sortValue: (r) => r.workflow },
                { key: "repo", header: "Repository", render: (r) => r.repo, sortValue: (r) => r.repo },
                {
                  key: "runs",
                  header: "Runs",
                  align: "right",
                  render: (r) => full(r.runs),
                  sortValue: (r) => r.runs,
                },
                {
                  key: "p50",
                  header: "Median",
                  align: "right",
                  render: (r) => formatDuration(r.p50),
                  sortValue: (r) => r.p50,
                },
                {
                  key: "p90",
                  header: "p90",
                  align: "right",
                  render: (r) => formatDuration(r.p90),
                  sortValue: (r) => r.p90,
                },
              ]}
            />
          }
        >
          <RankedBars
            valueLabel="median minutes"
            data={stats.slice(0, 15).map((s) => ({
              name: `${s.workflow.slice(0, 24)} · ${s.repo.split("/").pop()}`,
              value: Math.round((s.p50 / 60_000) * 10) / 10,
            }))}
          />
        </ChartCard>

        <ChartCard
          title="Where the time actually goes"
          subtitle="Total elapsed time — slow multiplied by frequent"
          loading={runs.isFetching}
          table={
            <DataTable
              rows={costliest}
              maxHeight={360}
              rowKey={(r) => r.key}
              initialSort={{ key: "total", dir: "desc" }}
              columns={[
                { key: "workflow", header: "Workflow", render: (r) => r.workflow },
                { key: "repo", header: "Repository", render: (r) => r.repo },
                {
                  key: "runs",
                  header: "Runs",
                  align: "right",
                  render: (r) => full(r.runs),
                  sortValue: (r) => r.runs,
                },
                {
                  key: "total",
                  header: "Total elapsed",
                  align: "right",
                  render: (r) => formatDuration(r.total),
                  sortValue: (r) => r.total,
                },
              ]}
            />
          }
        >
          <RankedBars
            valueLabel="total minutes"
            data={costliest.slice(0, 15).map((s) => ({
              name: `${s.workflow.slice(0, 24)} · ${s.repo.split("/").pop()}`,
              value: Math.round(s.total / 60_000),
            }))}
          />
        </ChartCard>

        <Card>
          <CardHeader
            title="Least reliable workflows"
            subtitle="Ten or more runs, ranked by failure rate"
          />
          <DataTable
            rows={stats.filter((s) => s.runs >= 10)}
            maxHeight={420}
            empty="No workflow has ten or more runs in this period"
            rowKey={(r) => r.key}
            initialSort={{ key: "rate", dir: "desc" }}
            columns={[
              { key: "workflow", header: "Workflow", render: (r) => r.workflow, sortValue: (r) => r.workflow },
              { key: "repo", header: "Repository", render: (r) => r.repo },
              {
                key: "runs",
                header: "Runs",
                align: "right",
                render: (r) => full(r.runs),
                sortValue: (r) => r.runs,
              },
              {
                key: "failures",
                header: "Failures",
                align: "right",
                render: (r) => full(r.failures),
                sortValue: (r) => r.failures,
              },
              {
                key: "rate",
                header: "Failure rate",
                align: "right",
                render: (r) => {
                  const rate = r.failures / r.runs;
                  const tone =
                    rate >= 0.25
                      ? "var(--status-critical)"
                      : rate >= 0.1
                        ? "var(--status-warning)"
                        : "var(--text-secondary)";
                  return (
                    <span style={{ color: tone }}>
                      {rate >= 0.25 ? "▲ " : rate >= 0.1 ? "◆ " : ""}
                      {Math.round(rate * 100)}%
                    </span>
                  );
                },
                sortValue: (r) => r.failures / r.runs,
              },
            ]}
          />
        </Card>
      </div>
    </PageShell>
  );
}
