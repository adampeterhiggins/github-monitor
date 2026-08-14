import { useMemo, useState } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import { contributorWeeklyByLogin, ownershipCells } from "../lib/db/queries";
import { allocateUnits, concentration } from "../lib/agg/concentration";
import { PERIODS, axisWeeksFor, dayKey, formatDate } from "../lib/agg/weeks";
import { useApp } from "../lib/state/app";
import { useVizPalette } from "../lib/viz/useVizPalette";
import { seriesColorCycled } from "../lib/viz/palette";
import { PageShell } from "../components/PageShell";
import { DailyLines, HeatMatrix, Waffle, otherColor, type HeatTooltipContent } from "../components/charts";
import {
  Callout,
  Card,
  CardHeader,
  ChartCard,
  DataTable,
  FilterPopover,
  LabeledControl,
  Segmented,
  Slider,
  StatTile,
  full,
} from "../components/ui";

const LIMITS = [12, 24, 40, 60] as const;
type MatrixLimit = (typeof LIMITS)[number] | "all";
type MatrixAxis = "people" | "repos";

const DEFAULT_PEOPLE: MatrixLimit = 24;
const DEFAULT_REPOS: MatrixLimit = 24;
const DEFAULT_CELL = 18;
const DEFAULT_GAP = 2;
const DEFAULT_BORDERS = true;
const CELL_MIN = 8;
const CELL_MAX = 48;
const GAP_MAX = 12;

const LIMIT_OPTIONS: Array<{ value: MatrixLimit; label: string }> = [
  ...LIMITS.map((n) => ({ value: n, label: String(n) })),
  { value: "all", label: "All" },
];

function pct(share: number): string {
  if (share <= 0) return "0%";
  const n = share * 100;
  return n < 10 ? `${n.toFixed(1)}%` : `${Math.round(n)}%`;
}

function repoShort(fullName: string): string {
  const slash = fullName.lastIndexOf("/");
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}

function take<T>(items: T[], limit: MatrixLimit): T[] {
  return limit === "all" ? items : items.slice(0, limit);
}

export function Ownership() {
  const scope = useScope();
  const period = useApp((s) => s.period);
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? "the selected period";
  const palette = useVizPalette();

  const [peopleLimit, setPeopleLimit] = useState<MatrixLimit>(DEFAULT_PEOPLE);
  const [repoLimit, setRepoLimit] = useState<MatrixLimit>(DEFAULT_REPOS);
  const [rowsAre, setRowsAre] = useState<MatrixAxis>("people");
  const [cellSize, setCellSize] = useState(DEFAULT_CELL);
  const [gap, setGap] = useState(DEFAULT_GAP);
  const [borders, setBorders] = useState(DEFAULT_BORDERS);

  const cells = useScopedQuery("ownership-cells", scope, (db) =>
    ownershipCells(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek, scope.logins),
  );
  const weekly = useScopedQuery("ownership-weekly", scope, (db) =>
    contributorWeeklyByLogin(
      db,
      scope.repoIds,
      scope.range.fromWeek,
      scope.range.toWeek,
      scope.logins,
    ),
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

  const overTime = useMemo(() => {
    const byWeek = new Map<number, number[]>();
    for (const r of weekly.data ?? []) {
      const commits = Number(r.commits);
      if (commits <= 0) continue;
      const list = byWeek.get(r.week) ?? [];
      list.push(commits);
      byWeek.set(r.week, list);
    }
    return axisWeeksFor(scope.range.fromWeek, scope.range.toWeek, [...byWeek.keys()]).map((week) => {
      const c = concentration(byWeek.get(week) ?? []);
      return {
        week,
        day: dayKey(week * 1000),
        top1: Math.round(c.top1 * 100),
        top3: Math.round(c.top3 * 100),
        top5: Math.round(c.top5 * 100),
        commits: c.total,
        people: c.contributors,
      };
    });
  }, [weekly.data, scope.range.fromWeek, scope.range.toWeek]);

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
    const people = take(byPerson, peopleLimit);
    const repos = take(byRepo, repoLimit);
    const lookup = new Map<
      string,
      { commits: number; additions: number; deletions: number }
    >();
    for (const r of rows) {
      lookup.set(`${r.login.toLowerCase()}|${r.repo_id}`, {
        commits: Number(r.commits),
        additions: Number(r.additions),
        deletions: Number(r.deletions),
      });
    }

    const peopleAsRows = rowsAre === "people";
    const rowItems = peopleAsRows ? people : repos;
    const colItems = peopleAsRows ? repos : people;

    const cellAt = (r: number, c: number) => {
      const person = peopleAsRows ? people[r] : people[c];
      const repo = peopleAsRows ? repos[c] : repos[r];
      return {
        person,
        repo,
        cell: lookup.get(`${person.login.toLowerCase()}|${repo.repo_id}`) ?? {
          commits: 0,
          additions: 0,
          deletions: 0,
        },
      };
    };

    const values = rowItems.map((_, r) => colItems.map((__, c) => cellAt(r, c).cell.commits));

    const headerTooltip = (axis: "row" | "column", index: number): HeatTooltipContent => {
      if ((axis === "row") === peopleAsRows) {
        const p = people[index];
        return {
          heading: p.login,
          rows: [
            { label: "commits in range", value: full(p.commits) },
            {
              label: "of everyone",
              value: pct(org.total === 0 ? 0 : p.commits / org.total),
            },
          ],
        };
      }
      const repo = repos[index];
      const c = concentration(repo.counts);
      return {
        heading: repo.full_name,
        rows: [
          { label: "commits in range", value: full(repo.commits) },
          { label: "people", value: full(c.contributors) },
          { label: "top person", value: repo.topLogin },
          { label: "top 1 share", value: pct(c.top1) },
        ],
      };
    };

    const cellTooltip = (_value: number, r: number, c: number): HeatTooltipContent => {
      const { person, repo, cell } = cellAt(r, c);
      return {
        heading: `${person.login} · ${repo.full_name}`,
        rows: [
          { label: "commits", value: cell.commits === 0 ? "none" : full(cell.commits) },
          { label: "additions", value: full(cell.additions) },
          { label: "deletions", value: full(cell.deletions) },
          {
            label: "of this person",
            value: pct(person.commits === 0 ? 0 : cell.commits / person.commits),
          },
          {
            label: "of this repository",
            value: pct(repo.commits === 0 ? 0 : cell.commits / repo.commits),
          },
        ],
      };
    };

    return {
      rowLabels: peopleAsRows ? people.map((p) => p.login) : repos.map((r) => repoShort(r.full_name)),
      columnLabels: peopleAsRows
        ? repos.map((r) => repoShort(r.full_name))
        : people.map((p) => p.login),
      values,
      headerTooltip,
      cellTooltip,
      shownPeople: people.length,
      shownRepos: repos.length,
      hiddenPeople: Math.max(0, byPerson.length - people.length),
      hiddenRepos: Math.max(0, byRepo.length - repos.length),
    };
  }, [byPerson, byRepo, rows, peopleLimit, repoLimit, rowsAre, org.total]);

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

      <ChartCard
        title="Concentration over time"
        subtitle="Share of that week's commits held by the most active people"
        loading={weekly.isFetching}
        table={
          <DataTable
            rows={overTime.filter((d) => d.commits > 0)}
            maxHeight={320}
            empty="No weekly commits in this selection"
            rowKey={(r) => r.week}
            initialSort={{ key: "week", dir: "desc" }}
            columns={[
              {
                key: "week",
                header: "Week of",
                render: (r) => formatDate(r.week * 1000),
                sortValue: (r) => r.week,
              },
              {
                key: "top1",
                header: "Top person",
                align: "right",
                render: (r) => `${r.top1}%`,
                sortValue: (r) => r.top1,
              },
              {
                key: "top3",
                header: "Top 3",
                align: "right",
                render: (r) => `${r.top3}%`,
                sortValue: (r) => r.top3,
              },
              {
                key: "top5",
                header: "Top 5",
                align: "right",
                render: (r) => `${r.top5}%`,
                sortValue: (r) => r.top5,
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
            ]}
          />
        }
      >
        <DailyLines
          data={overTime}
          series={[
            { key: "top1", label: "Top person", slot: 0 },
            { key: "top3", label: "Top 3", slot: 1 },
            { key: "top5", label: "Top 5", slot: 2 },
          ]}
          height={240}
          valueFormatter={(n) => `${n}%`}
        />
      </ChartCard>

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
        title={rowsAre === "people" ? "People × repositories" : "Repositories × people"}
        subtitle={
          matrix.hiddenPeople || matrix.hiddenRepos
            ? `Busiest ${full(matrix.shownPeople)} people and ${full(matrix.shownRepos)} repositories — ${
                matrix.hiddenPeople ? `${full(matrix.hiddenPeople)} more people` : ""
              }${matrix.hiddenPeople && matrix.hiddenRepos ? ", " : ""}${
                matrix.hiddenRepos ? `${full(matrix.hiddenRepos)} more repositories` : ""
              } live in the table`
            : `Every person and repository with commits in the period`
        }
        loading={cells.isFetching}
        titleAfter={
          <FilterPopover
            label="Matrix options"
            active={
              peopleLimit !== DEFAULT_PEOPLE ||
              repoLimit !== DEFAULT_REPOS ||
              rowsAre !== "people" ||
              cellSize !== DEFAULT_CELL ||
              gap !== DEFAULT_GAP ||
              borders !== DEFAULT_BORDERS
            }
            width={320}
          >
            <LabeledControl label="People">
              <Segmented
                ariaLabel="People to show"
                stretch
                variant="bare"
                value={String(peopleLimit)}
                options={LIMIT_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
                onChange={(v) => setPeopleLimit(v === "all" ? "all" : (Number(v) as MatrixLimit))}
              />
            </LabeledControl>
            <LabeledControl label="Repos">
              <Segmented
                ariaLabel="Repositories to show"
                stretch
                variant="bare"
                value={String(repoLimit)}
                options={LIMIT_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
                onChange={(v) => setRepoLimit(v === "all" ? "all" : (Number(v) as MatrixLimit))}
              />
            </LabeledControl>
            <LabeledControl label="Rows">
              <Segmented
                ariaLabel="Which axis is the rows"
                stretch
                variant="bare"
                value={rowsAre}
                options={[
                  { value: "people", label: "People" },
                  { value: "repos", label: "Repositories" },
                ]}
                onChange={setRowsAre}
              />
            </LabeledControl>
            <LabeledControl label="Size">
              <Slider
                ariaLabel="Square size"
                min={CELL_MIN}
                max={CELL_MAX}
                value={cellSize}
                onChange={setCellSize}
                format={(n) => `${n}px`}
              />
            </LabeledControl>
            <LabeledControl label="Gap">
              <Slider
                ariaLabel="Space between squares"
                min={0}
                max={GAP_MAX}
                value={gap}
                onChange={setGap}
                format={(n) => `${n}px`}
              />
            </LabeledControl>
            <LabeledControl label="Border">
              <Segmented
                ariaLabel="Empty-square borders"
                stretch
                variant="bare"
                value={borders ? "on" : "off"}
                options={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
                onChange={(v) => setBorders(v === "on")}
              />
            </LabeledControl>
          </FilterPopover>
        }
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
          headerTooltip={matrix.headerTooltip}
          cellTooltip={matrix.cellTooltip}
          cellSize={cellSize}
          gap={gap}
          borders={borders}
        />
      </ChartCard>

      <p className="text-[11px] text-ink-muted">
        {formatDate(scope.range.fromMs)} – {formatDate(scope.range.toMs)}. Cell intensity is
        commits in that window.
      </p>
    </PageShell>
  );
}
