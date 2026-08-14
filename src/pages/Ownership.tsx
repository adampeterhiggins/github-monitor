import { useMemo } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import { ownershipCells } from "../lib/db/queries";
import { allocateUnits, concentration } from "../lib/agg/concentration";
import { PERIODS, formatDate } from "../lib/agg/weeks";
import { useApp } from "../lib/state/app";
import { useVizPalette } from "../lib/viz/useVizPalette";
import { seriesColorCycled } from "../lib/viz/palette";
import { PageShell } from "../components/PageShell";
import { HeatMatrix, Waffle, otherColor } from "../components/charts";
import { Callout, Card, CardHeader, ChartCard, DataTable, StatTile, full } from "../components/ui";

const MATRIX_PEOPLE = 30;
const MATRIX_REPOS = 24;

function pct(share: number): string {
  if (share <= 0) return "0%";
  const n = share * 100;
  return n < 10 ? `${n.toFixed(1)}%` : `${Math.round(n)}%`;
}

function repoShort(fullName: string): string {
  const slash = fullName.lastIndexOf("/");
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}

export function Ownership() {
  const scope = useScope();
  const period = useApp((s) => s.period);
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? "the selected period";
  const palette = useVizPalette();

  const cells = useScopedQuery("ownership-cells", scope, (db) =>
    ownershipCells(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek, scope.logins),
  );

  const rows = cells.data ?? [];

  const byPerson = useMemo(() => {
    const map = new Map<string, { login: string; commits: number }>();
    for (const r of rows) {
      const key = r.login.toLowerCase();
      const seen = map.get(key);
      if (seen) seen.commits += Number(r.commits);
      else map.set(key, { login: r.login, commits: Number(r.commits) });
    }
    return [...map.values()].sort((a, b) => b.commits - a.commits || a.login.localeCompare(b.login));
  }, [rows]);

  const byRepo = useMemo(() => {
    const map = new Map<
      number,
      { repo_id: number; full_name: string; commits: number; counts: number[]; topLogin: string }
    >();
    for (const r of rows) {
      const commits = Number(r.commits);
      const seen = map.get(r.repo_id);
      if (!seen) {
        map.set(r.repo_id, {
          repo_id: r.repo_id,
          full_name: r.full_name,
          commits,
          counts: [commits],
          topLogin: r.login,
        });
        continue;
      }
      seen.commits += commits;
      seen.counts.push(commits);
      if (commits > Math.max(...seen.counts.slice(0, -1), 0)) seen.topLogin = r.login;
    }
    return [...map.values()].sort((a, b) => b.commits - a.commits || a.full_name.localeCompare(b.full_name));
  }, [rows]);

  const org = useMemo(() => concentration(byPerson.map((p) => p.commits)), [byPerson]);

  const waffle = useMemo(() => {
    const top = byPerson.slice(0, 8);
    const rest = byPerson.slice(8);
    const weights = [...top.map((p) => p.commits), rest.reduce((a, p) => a + p.commits, 0)];
    const units = allocateUnits(weights, 100);
    const items = top.map((p, i) => ({
      label: p.login,
      count: units[i] ?? 0,
      color: seriesColorCycled(palette, i),
    }));
    if (rest.length > 0) {
      items.push({
        label: `Other (${rest.length})`,
        count: units[top.length] ?? 0,
        color: otherColor(palette),
      });
    }
    return items;
  }, [byPerson, palette]);

  const matrix = useMemo(() => {
    const people = byPerson.slice(0, MATRIX_PEOPLE);
    const repos = byRepo.slice(0, MATRIX_REPOS);
    const lookup = new Map<string, number>();
    for (const r of rows) lookup.set(`${r.login.toLowerCase()}|${r.repo_id}`, Number(r.commits));
    const values = people.map((p) =>
      repos.map((repo) => lookup.get(`${p.login.toLowerCase()}|${repo.repo_id}`) ?? 0),
    );
    return {
      rowLabels: people.map((p) => p.login),
      columnLabels: repos.map((r) => repoShort(r.full_name)),
      values,
      hiddenPeople: Math.max(0, byPerson.length - people.length),
      hiddenRepos: Math.max(0, byRepo.length - repos.length),
    };
  }, [byPerson, byRepo, rows]);

  const repoTable = useMemo(
    () =>
      byRepo.map((r) => {
        const c = concentration(r.counts);
        return { ...r, ...c };
      }),
    [byRepo],
  );

  return (
    <PageShell
      title="Ownership"
      subtitle={`Who holds the commits across ${full(scope.repoIds.length)} ${
        scope.repoIds.length === 1 ? "repository" : "repositories"
      } — ${periodLabel.toLowerCase()}`}
      userFilter="full"
    >
      <Callout>
        GitHub never shows how concentrated a repository is. These figures are the
        share of commits in the selected period held by the most active people —
        a bus-factor reading, not a judgement. Merge commits and non-default
        branches are already excluded, because that is what GitHub's contributor
        stats count.
      </Callout>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Top person" value={pct(org.top1)} hint="Share of commits" />
        <StatTile label="Top 3" value={pct(org.top3)} hint="Share of commits" />
        <StatTile label="Top 5" value={pct(org.top5)} hint="Share of commits" />
        <StatTile
          label="People"
          value={org.contributors}
          hint={`${full(org.total)} commits in range`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard
          title="Commit share"
          subtitle="One hundred squares, one percent each"
          loading={cells.isFetching}
          table={
            <DataTable
              rows={byPerson}
              maxHeight={320}
              rowKey={(r) => r.login}
              initialSort={{ key: "commits", dir: "desc" }}
              columns={[
                { key: "login", header: "Contributor", render: (r) => r.login, sortValue: (r) => r.login },
                {
                  key: "commits",
                  header: "Commits",
                  align: "right",
                  render: (r) => full(r.commits),
                  sortValue: (r) => r.commits,
                },
                {
                  key: "share",
                  header: "Share",
                  align: "right",
                  render: (r) => pct(org.total === 0 ? 0 : r.commits / org.total),
                  sortValue: (r) => r.commits,
                },
              ]}
            />
          }
        >
          <Waffle cells={waffle} />
        </ChartCard>

        <Card>
          <CardHeader
            title="Per-repository concentration"
            subtitle="Repositories whose commits sit with the fewest people rise to the top"
          />
          <DataTable
            rows={repoTable}
            maxHeight={340}
            empty="No commits in this selection"
            rowKey={(r) => r.repo_id}
            initialSort={{ key: "top1", dir: "desc" }}
            columns={[
              {
                key: "repo",
                header: "Repository",
                render: (r) => r.full_name,
                sortValue: (r) => r.full_name,
              },
              {
                key: "people",
                header: "People",
                align: "right",
                render: (r) => full(r.contributors),
                sortValue: (r) => r.contributors,
              },
              {
                key: "top",
                header: "Top person",
                render: (r) => r.topLogin,
                sortValue: (r) => r.topLogin,
              },
              {
                key: "top1",
                header: "Top 1",
                align: "right",
                render: (r) => pct(r.top1),
                sortValue: (r) => r.top1,
              },
              {
                key: "top3",
                header: "Top 3",
                align: "right",
                render: (r) => pct(r.top3),
                sortValue: (r) => r.top3,
              },
            ]}
          />
        </Card>
      </div>

      <ChartCard
        title="People × repositories"
        subtitle={
          matrix.hiddenPeople || matrix.hiddenRepos
            ? `Busiest ${full(Math.min(byPerson.length, MATRIX_PEOPLE))} people and ${full(
                Math.min(byRepo.length, MATRIX_REPOS),
              )} repositories — ${
                matrix.hiddenPeople ? `${full(matrix.hiddenPeople)} more people` : ""
              }${matrix.hiddenPeople && matrix.hiddenRepos ? ", " : ""}${
                matrix.hiddenRepos ? `${full(matrix.hiddenRepos)} more repositories` : ""
              } live in the table`
            : `Every person and repository with commits in the period`
        }
        loading={cells.isFetching}
        table={
          <DataTable
            rows={rows}
            maxHeight={420}
            empty="No commits in this selection"
            rowKey={(r) => `${r.login}:${r.repo_id}`}
            initialSort={{ key: "commits", dir: "desc" }}
            columns={[
              { key: "login", header: "Contributor", render: (r) => r.login, sortValue: (r) => r.login },
              {
                key: "repo",
                header: "Repository",
                render: (r) => r.full_name,
                sortValue: (r) => r.full_name,
              },
              {
                key: "commits",
                header: "Commits",
                align: "right",
                render: (r) => full(Number(r.commits)),
                sortValue: (r) => Number(r.commits),
              },
              {
                key: "additions",
                header: "Additions",
                align: "right",
                render: (r) => full(Number(r.additions)),
                sortValue: (r) => Number(r.additions),
              },
              {
                key: "deletions",
                header: "Deletions",
                align: "right",
                render: (r) => full(Number(r.deletions)),
                sortValue: (r) => Number(r.deletions),
              },
            ]}
          />
        }
      >
        <HeatMatrix
          rowLabels={matrix.rowLabels}
          columnLabels={matrix.columnLabels}
          values={matrix.values}
          format={(v) => full(v)}
        />
      </ChartCard>

      <p className="text-[11px] text-ink-muted">
        {formatDate(scope.range.fromMs)} – {formatDate(scope.range.toMs)}. Cell intensity is
        commits in that window.
      </p>
    </PageShell>
  );
}
