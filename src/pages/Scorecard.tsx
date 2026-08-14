import { useMemo } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import {
  communityRows,
  dependabotAlertRows,
  mergedPrScatter,
  openPullRequests,
  ownershipCells,
  trafficByRepo,
} from "../lib/db/queries";
import { concentration } from "../lib/agg/concentration";
import { PERIODS, formatDate } from "../lib/agg/weeks";
import { useApp } from "../lib/state/app";
import { PageShell } from "../components/PageShell";
import { Callout, Card, CardHeader, DataTable, StatTile, full } from "../components/ui";

function pct(share: number): string {
  if (share <= 0) return "0%";
  const n = share * 100;
  return n < 10 ? `${n.toFixed(1)}%` : `${Math.round(n)}%`;
}

function hoursLabel(h: number): string {
  if (h <= 0) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function Scorecard() {
  const scope = useScope();
  const period = useApp((s) => s.period);
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? "the selected period";

  const cells = useScopedQuery("scorecard-ownership", scope, (db) =>
    ownershipCells(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek),
  );
  const community = useScopedQuery("scorecard-community", scope, (db) =>
    communityRows(db, scope.repoIds),
  );
  const alerts = useScopedQuery("scorecard-alerts", scope, (db) =>
    dependabotAlertRows(db, scope.repoIds),
  );
  const scatter = useScopedQuery("scorecard-prs", scope, (db) =>
    mergedPrScatter(db, scope.repoIds, scope.fromIso, scope.toIso),
  );
  const open = useScopedQuery("scorecard-open", scope, (db) =>
    openPullRequests(db, scope.repoIds, new Date().toISOString()),
  );
  const traffic = useScopedQuery("scorecard-traffic", scope, (db) =>
    trafficByRepo(db, scope.repoIds, scope.fromDay, scope.toDay),
  );

  const rows = useMemo(() => {
    const byRepo = new Map<
      string,
      { full_name: string; commits: number; counts: number[] }
    >();
    for (const r of cells.data ?? []) {
      const seen = byRepo.get(r.full_name);
      const commits = Number(r.commits);
      if (!seen) {
        byRepo.set(r.full_name, { full_name: r.full_name, commits, counts: [commits] });
        continue;
      }
      seen.commits += commits;
      seen.counts.push(commits);
    }

    const health = new Map((community.data ?? []).map((r) => [r.full_name, Number(r.health)]));
    const alertCount = new Map<string, number>();
    for (const a of alerts.data ?? []) {
      alertCount.set(a.full_name, (alertCount.get(a.full_name) ?? 0) + 1);
    }
    const hoursByRepo = new Map<string, number[]>();
    for (const p of scatter.data ?? []) {
      const hours = Number(p.hours);
      if (!Number.isFinite(hours) || hours < 0) continue;
      const list = hoursByRepo.get(p.full_name) ?? [];
      list.push(hours);
      hoursByRepo.set(p.full_name, list);
    }
    const openByRepo = new Map<string, number>();
    for (const p of open.data ?? []) {
      openByRepo.set(p.full_name, (openByRepo.get(p.full_name) ?? 0) + 1);
    }
    const views = new Map((traffic.data ?? []).map((r) => [r.full_name, Number(r.views)]));

    const names = new Set<string>([
      ...byRepo.keys(),
      ...health.keys(),
      ...alertCount.keys(),
      ...hoursByRepo.keys(),
      ...openByRepo.keys(),
      ...views.keys(),
    ]);

    return [...names].map((full_name) => {
      const owned = byRepo.get(full_name);
      const conc = concentration(owned?.counts ?? []);
      const lead = hoursByRepo.get(full_name) ?? [];
      return {
        full_name,
        commits: owned?.commits ?? 0,
        people: conc.contributors,
        top1: conc.top1,
        health: health.get(full_name) ?? 0,
        alerts: alertCount.get(full_name) ?? 0,
        openPrs: openByRepo.get(full_name) ?? 0,
        p50: lead.length ? percentile(lead, 0.5) : null,
        views: views.get(full_name) ?? 0,
      };
    });
  }, [cells.data, community.data, alerts.data, scatter.data, open.data, traffic.data]);

  const loading =
    cells.isFetching ||
    community.isFetching ||
    alerts.isFetching ||
    scatter.isFetching ||
    open.isFetching ||
    traffic.isFetching;

  const concentrated = rows.filter((r) => r.people > 0 && r.top1 >= 0.8).length;
  const withAlerts = rows.filter((r) => r.alerts > 0).length;
  const withOpen = rows.filter((r) => r.openPrs > 0).length;
  const lowHealth = rows.filter((r) => r.health > 0 && r.health < 50).length;

  return (
    <PageShell
      title="Scorecard"
      subtitle={`Where to look across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      } — ${periodLabel.toLowerCase()}`}
      userFilter="none"
    >
      <Callout>
        One row per repository, joining signals that live on different pages:
        commit concentration, community health, open Dependabot alerts, open
        pull requests, median time-to-merge, and views. There is no composite
        score — each column is its own ranking. Concentration, merges and views
        follow the selected period; alerts and open pull requests are the
        current cache. The contributor filter is off because traffic, community
        health and alerts have no person dimension.
      </Callout>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Top-1 ≥ 80%" value={concentrated} hint="One person holds most commits" />
        <StatTile label="Open alerts" value={withAlerts} hint="Repositories with Dependabot" />
        <StatTile label="Open pull requests" value={withOpen} hint="Still open in the cache" />
        <StatTile label="Health below 50" value={lowHealth} hint="Community checklist" />
      </div>

      <Card>
        <CardHeader
          title="Repositories"
          subtitle={loading ? "Refreshing…" : `${formatDate(scope.range.fromMs)} – ${formatDate(scope.range.toMs)}`}
        />
        <DataTable
          rows={rows}
          maxHeight={560}
          empty="No repositories in this selection"
          rowKey={(r) => r.full_name}
          initialSort={{ key: "top1", dir: "desc" }}
          columns={[
            {
              key: "repo",
              header: "Repository",
              render: (r) => r.full_name,
              sortValue: (r) => r.full_name,
            },
            {
              key: "top1",
              header: "Top-1 share",
              align: "right",
              render: (r) => (r.people === 0 ? "—" : pct(r.top1)),
              sortValue: (r) => r.top1,
            },
            {
              key: "people",
              header: "People",
              align: "right",
              render: (r) => full(r.people),
              sortValue: (r) => r.people,
            },
            {
              key: "commits",
              header: "Commits",
              align: "right",
              render: (r) => full(r.commits),
              sortValue: (r) => r.commits,
            },
            {
              key: "health",
              header: "Health",
              align: "right",
              render: (r) => full(r.health),
              sortValue: (r) => r.health,
            },
            {
              key: "alerts",
              header: "Alerts",
              align: "right",
              render: (r) => full(r.alerts),
              sortValue: (r) => r.alerts,
            },
            {
              key: "open",
              header: "Open PRs",
              align: "right",
              render: (r) => full(r.openPrs),
              sortValue: (r) => r.openPrs,
            },
            {
              key: "p50",
              header: "PR p50",
              align: "right",
              render: (r) => (r.p50 == null ? "—" : hoursLabel(r.p50)),
              sortValue: (r) => r.p50 ?? -1,
            },
            {
              key: "views",
              header: "Views",
              align: "right",
              render: (r) => full(r.views),
              sortValue: (r) => r.views,
            },
          ]}
        />
      </Card>
    </PageShell>
  );
}
