import { useMemo } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import {
  mergedPrDurations,
  pulseAuthors,
  pulseByRepo,
  pulseDaily,
  pulseSummary,
} from "../lib/db/queries";
import { PERIODS, formatDate } from "../lib/agg/weeks";
import { useApp } from "../lib/state/app";
import { PageShell } from "../components/PageShell";
import { DailyLines, RankedBars, StatusBar } from "../components/charts";
import { Callout, Card, CardHeader, ChartCard, DataTable, StatTile, full } from "../components/ui";

/** Percentile from an unsorted sample; p in [0,1]. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function hoursLabel(h: number): string {
  if (h <= 0) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function Pulse() {
  const scope = useScope();
  const period = useApp((s) => s.period);
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? "the selected period";

  const summary = useScopedQuery("pulse-summary", scope, (db) =>
    pulseSummary(
      db,
      scope.repoIds,
      scope.fromIso,
      scope.toIso,
      scope.range.fromWeek,
      scope.range.toWeek,
      scope.logins,
    ),
  );

  const daily = useScopedQuery("pulse-daily", scope, (db) =>
    pulseDaily(db, scope.repoIds, scope.fromIso, scope.toIso, scope.logins),
  );

  const byRepo = useScopedQuery("pulse-by-repo", scope, (db) =>
    pulseByRepo(db, scope.repoIds, scope.fromIso, scope.toIso, scope.logins),
  );

  const authors = useScopedQuery("pulse-authors", scope, (db) =>
    pulseAuthors(db, scope.repoIds, scope.fromIso, scope.toIso, scope.logins),
  );

  const durations = useScopedQuery("pulse-durations", scope, (db) =>
    mergedPrDurations(db, scope.repoIds, scope.fromIso, scope.toIso, scope.logins),
  );

  const s = summary.data;

  const dailySeries = useMemo(() => {
    const rows = daily.data ?? [];
    return rows.map((r) => ({
      day: r.day,
      opened: Number(r.opened),
      merged: Number(r.merged),
    }));
  }, [daily.data]);

  const leadTimes = useMemo(
    () => (durations.data ?? []).map((d) => Number(d.hours)).filter((h) => Number.isFinite(h) && h >= 0),
    [durations.data],
  );

  const p50 = percentile(leadTimes, 0.5);
  const p90 = percentile(leadTimes, 0.9);

  return (
    <PageShell
      title="Pulse"
      subtitle={`Activity across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      } — ${periodLabel.toLowerCase()}`}
      userFilter="full"
    >
      <div className="flex flex-col gap-4">
        <Callout>
          GitHub has no Pulse API, so this page is derived from pull requests, issues and commit
          statistics. Definitions are ours: “merged” counts pull requests whose merge fell inside
          the period, regardless of when they were opened.
        </Callout>

        {s ? (
          <Card>
            <CardHeader title="Summary" subtitle={`${formatDate(scope.range.fromMs)} – ${formatDate(scope.range.toMs)}`} />
            <p className="text-[13px] leading-relaxed text-ink">
              <strong className="font-semibold">{full(s.activeAuthors)}</strong> author
              {s.activeAuthors === 1 ? "" : "s"} pushed{" "}
              <strong className="font-semibold">{full(s.commits)}</strong> commit
              {s.commits === 1 ? "" : "s"} to{" "}
              <strong className="font-semibold">{full(s.reposActive)}</strong> repositor
              {s.reposActive === 1 ? "y" : "ies"}. On top of that,{" "}
              <strong className="font-semibold">{full(s.prsMerged)}</strong> pull request
              {s.prsMerged === 1 ? "" : "s"} merged and{" "}
              <strong className="font-semibold">{full(s.prsOpened)}</strong> opened, while{" "}
              <strong className="font-semibold">{full(s.issuesClosed)}</strong> issue
              {s.issuesClosed === 1 ? "" : "s"} closed and{" "}
              <strong className="font-semibold">{full(s.issuesOpened)}</strong> opened.
            </p>
          </Card>
        ) : null}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Pull requests merged" value={s?.prsMerged ?? 0} />
          <StatTile label="Pull requests opened" value={s?.prsOpened ?? 0} />
          <StatTile label="Issues closed" value={s?.issuesClosed ?? 0} />
          <StatTile label="Issues opened" value={s?.issuesOpened ?? 0} />
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard
            title="Pull requests over time"
            subtitle="Opened and merged per day"
            loading={daily.isFetching}
            table={
              <DataTable
                rows={dailySeries}
                maxHeight={300}
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
                    key: "opened",
                    header: "Opened",
                    align: "right",
                    render: (r) => full(r.opened),
                    sortValue: (r) => r.opened,
                  },
                  {
                    key: "merged",
                    header: "Merged",
                    align: "right",
                    render: (r) => full(r.merged),
                    sortValue: (r) => r.merged,
                  },
                ]}
              />
            }
          >
            <DailyLines
              data={dailySeries}
              series={[
                { key: "opened", label: "Opened", slot: 0 },
                { key: "merged", label: "Merged", slot: 1 },
              ]}
              height={240}
            />
          </ChartCard>

          <Card>
            <CardHeader
              title="Pull request outcomes"
              subtitle="Everything opened in the period, by where it ended up"
            />
            <div className="mb-4">
              <StatusBar
                total={(s?.prsMerged ?? 0) + (s?.prsClosedUnmerged ?? 0)}
                segments={[
                  { label: "merged", value: s?.prsMerged ?? 0, tone: "good" },
                  { label: "closed without merging", value: s?.prsClosedUnmerged ?? 0, tone: "muted" },
                ]}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <StatTile
                label="Median time to merge"
                value={hoursLabel(p50)}
                hint={`${full(leadTimes.length)} merged pull requests`}
              />
              <StatTile label="90th percentile" value={hoursLabel(p90)} hint="Slowest tenth" />
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard
            title="Most active authors"
            subtitle="By pull requests merged in the period"
            loading={authors.isFetching}
            table={
              <DataTable
                rows={authors.data ?? []}
                maxHeight={300}
                rowKey={(r) => r.author}
                initialSort={{ key: "merged", dir: "desc" }}
                columns={[
                  { key: "author", header: "Author", render: (r) => r.author, sortValue: (r) => r.author },
                  {
                    key: "opened",
                    header: "Opened",
                    align: "right",
                    render: (r) => full(Number(r.prs_opened)),
                    sortValue: (r) => Number(r.prs_opened),
                  },
                  {
                    key: "merged",
                    header: "Merged",
                    align: "right",
                    render: (r) => full(Number(r.prs_merged)),
                    sortValue: (r) => Number(r.prs_merged),
                  },
                  {
                    key: "reviews",
                    header: "Reviews on their PRs",
                    align: "right",
                    render: (r) => full(Number(r.reviews)),
                    sortValue: (r) => Number(r.reviews),
                  },
                ]}
              />
            }
          >
            <RankedBars
              valueLabel="merged"
              data={(authors.data ?? []).slice(0, 12).map((a) => ({
                name: a.author,
                value: Number(a.prs_merged),
              }))}
            />
          </ChartCard>

          <ChartCard
            title="Most active repositories"
            subtitle="By pull requests merged in the period"
            loading={byRepo.isFetching}
            table={
              <DataTable
                rows={byRepo.data ?? []}
                maxHeight={300}
                rowKey={(r) => r.full_name}
                initialSort={{ key: "merged", dir: "desc" }}
                columns={[
                  { key: "repo", header: "Repository", render: (r) => r.full_name },
                  {
                    key: "opened",
                    header: "PRs opened",
                    align: "right",
                    render: (r) => full(Number(r.prs_opened)),
                    sortValue: (r) => Number(r.prs_opened),
                  },
                  {
                    key: "merged",
                    header: "PRs merged",
                    align: "right",
                    render: (r) => full(Number(r.prs_merged)),
                    sortValue: (r) => Number(r.prs_merged),
                  },
                  {
                    key: "issues",
                    header: "Issues closed",
                    align: "right",
                    render: (r) => full(Number(r.issues_closed)),
                    sortValue: (r) => Number(r.issues_closed),
                  },
                ]}
              />
            }
          >
            <RankedBars
              valueLabel="merged"
              data={(byRepo.data ?? []).slice(0, 12).map((r) => ({
                name: r.full_name.split("/").pop() ?? r.full_name,
                value: Number(r.prs_merged),
              }))}
            />
          </ChartCard>
        </div>
      </div>
    </PageShell>
  );
}
