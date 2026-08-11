import { useMemo } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import { actionsDaily, actionsSummary, workflowDurations } from "../lib/db/queries";
import { formatDate } from "../lib/agg/weeks";
import { PageShell } from "../components/PageShell";
import { DailyLines, RankedBars, StatusBar } from "../components/charts";
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

export function ActionsUsage() {
  const scope = useScope();

  const summary = useScopedQuery("actions-summary", scope, (db) =>
    actionsSummary(db, scope.repoIds, scope.fromIso, scope.toIso),
  );
  const daily = useScopedQuery("actions-daily", scope, (db) =>
    actionsDaily(db, scope.repoIds, scope.fromIso, scope.toIso),
  );
  const runs = useScopedQuery("actions-runs", scope, (db) =>
    workflowDurations(db, scope.repoIds, scope.fromIso, scope.toIso),
  );

  const s = summary.data;

  const series = useMemo(
    () =>
      (daily.data ?? []).map((d) => ({
        day: d.day,
        runs: Number(d.runs),
        minutes: Math.round(Number(d.total_ms) / 60_000),
      })),
    [daily.data],
  );

  const byRepo = useMemo(() => {
    const map = new Map<string, { runs: number; ms: number }>();
    for (const r of runs.data ?? []) {
      const entry = map.get(r.full_name) ?? { runs: 0, ms: 0 };
      entry.runs += 1;
      entry.ms += Number(r.duration_ms);
      map.set(r.full_name, entry);
    }
    return [...map.entries()]
      .map(([full_name, v]) => ({ full_name, runs: v.runs, ms: v.ms }))
      .sort((a, b) => b.ms - a.ms);
  }, [runs.data]);

  const totalMinutes = Math.round((s?.totalMs ?? 0) / 60_000);

  return (
    <PageShell
      title="Actions usage metrics"
      subtitle={`Workflow run volume across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      }`}
    >
      <div className="flex flex-col gap-4">
        <Callout>
          Derived from workflow-run records rather than GitHub's billing API, so durations are
          wall-clock elapsed time per run — not billable minutes, which GitHub rounds up per job
          and multiplies by runner type. Treat these as relative volume, not an invoice. The
          sync caps at three pages of runs per repository, so very busy repositories may be
          undercounted.
        </Callout>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Workflow runs" value={s?.runs ?? 0} />
          <StatTile
            label="Success rate"
            value={s && s.runs ? `${Math.round((s.success / s.runs) * 100)}%` : "—"}
            hint={s ? `${full(s.failure)} failed` : undefined}
          />
          <StatTile label="Total elapsed" value={`${full(totalMinutes)}m`} hint="Wall clock" />
          <StatTile
            label="Average run"
            value={formatDuration(s && s.runs ? s.totalMs / s.runs : 0)}
          />
        </div>

        <Card>
          <CardHeader title="Run outcomes" subtitle="Every run created in the selected period" />
          <StatusBar
            total={s?.runs ?? 0}
            segments={[
              { label: "succeeded", value: s?.success ?? 0, tone: "good" },
              { label: "failed", value: s?.failure ?? 0, tone: "critical" },
              { label: "cancelled", value: s?.cancelled ?? 0, tone: "muted" },
              {
                label: "other",
                value: Math.max(
                  0,
                  (s?.runs ?? 0) - (s?.success ?? 0) - (s?.failure ?? 0) - (s?.cancelled ?? 0),
                ),
                tone: "warning",
              },
            ]}
          />
        </Card>

        <ChartCard
          title="Runs over time"
          subtitle="Daily run count and elapsed minutes"
          loading={daily.isFetching}
          table={
            <DataTable
              rows={series}
              maxHeight={320}
              rowKey={(r) => r.day}
              initialSort={{ key: "day", dir: "desc" }}
              columns={[
                {
                  key: "day",
                  header: "Day",
                  render: (r) => formatDate(new Date(`${r.day}T00:00:00Z`)),
                  sortValue: (r) => r.day,
                },
                {
                  key: "runs",
                  header: "Runs",
                  align: "right",
                  render: (r) => full(r.runs),
                  sortValue: (r) => r.runs,
                },
                {
                  key: "minutes",
                  header: "Elapsed minutes",
                  align: "right",
                  render: (r) => full(r.minutes),
                  sortValue: (r) => r.minutes,
                },
              ]}
            />
          }
        >
          {/* Runs and minutes have different scales, so they get separate charts
              rather than a second y-axis. */}
          <div className="flex flex-col gap-4">
            <div>
              <p className="mb-1 text-[11px] text-ink-secondary">Runs per day</p>
              <DailyLines
                data={series}
                series={[{ key: "runs", label: "Runs", slot: 0 }]}
                height={180}
              />
            </div>
            <div>
              <p className="mb-1 text-[11px] text-ink-secondary">Elapsed minutes per day</p>
              <DailyLines
                data={series}
                series={[{ key: "minutes", label: "Minutes", slot: 1 }]}
                height={180}
              />
            </div>
          </div>
        </ChartCard>

        <ChartCard
          title="Elapsed time by repository"
          subtitle="Top 15 by total wall-clock minutes"
          loading={runs.isFetching}
          table={
            <DataTable
              rows={byRepo}
              maxHeight={360}
              rowKey={(r) => r.full_name}
              initialSort={{ key: "minutes", dir: "desc" }}
              columns={[
                { key: "repo", header: "Repository", render: (r) => r.full_name, sortValue: (r) => r.full_name },
                {
                  key: "runs",
                  header: "Runs",
                  align: "right",
                  render: (r) => full(r.runs),
                  sortValue: (r) => r.runs,
                },
                {
                  key: "minutes",
                  header: "Elapsed",
                  align: "right",
                  render: (r) => formatDuration(r.ms),
                  sortValue: (r) => r.ms,
                },
              ]}
            />
          }
        >
          <RankedBars
            valueLabel="minutes"
            data={byRepo.slice(0, 15).map((r) => ({
              name: r.full_name.split("/").pop() ?? r.full_name,
              value: Math.round(r.ms / 60_000),
            }))}
          />
        </ChartCard>
      </div>
    </PageShell>
  );
}
