import { useCallback, useMemo, useState } from "react";
import { bucketLabel } from "../lib/agg/series";
import { formatDate } from "../lib/agg/weeks";
import { ownershipHistoryBuckets, ownershipHistorySeries, type OwnershipHistoryPoint, type OwnershipHistorySplit, type OwnershipPeriod, type OwnershipReading, type aggregateOwnership } from "../lib/lineOwnership";
import { HeatMatrix, RankedBars, TimelineArea, type TimelineShape } from "./charts";
import { ChartCard, DataTable, FilterPopover, LabeledControl, Segmented, ViewSelector, full } from "./ui";

type Summary = ReturnType<typeof aggregateOwnership>;
const percent = (value: number) => `${value.toFixed(1)}%`;
const share = (value: number) => percent(value * 100);
const shortRepo = (name: string) => name.slice(name.lastIndexOf("/") + 1);

const HISTORY_SHAPES: Array<{ value: TimelineShape; label: string }> = [
  { value: "bar", label: "Bars" },
  { value: "area", label: "Area" },
  { value: "line", label: "Line" },
];
const HISTORY_SPLITS: Array<{ value: OwnershipHistorySplit; label: string }> = [
  { value: "people", label: "People" },
  { value: "repository", label: "Repository" },
  { value: "total", label: "Total" },
];
const HISTORY_LIMITS = [
  { value: "4", label: "4" },
  { value: "6", label: "6" },
  { value: "8", label: "8" },
  { value: "all", label: "All" },
];
const HISTORY_STACKS = [
  { value: "stacked" as const, label: "Stacked" },
  { value: "overlaid" as const, label: "Overlaid" },
];
const HISTORY_VALUES = [
  { value: "total" as const, label: "Totals" },
  { value: "share" as const, label: "Share" },
];
const HISTORY_READINGS: Array<{ value: OwnershipReading; label: string }> = [
  { value: "cumulative", label: "Cumulative" },
  { value: "period", label: "Per period" },
];
const HISTORY_PERIODS: Array<{ value: OwnershipPeriod; label: string }> = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "quarter", label: "Quarterly" },
];
const PERIOD_SPAN = { day: "day", week: "week", month: "month", quarter: "quarter" } as const;

function historyCaption(reading: OwnershipReading, period: OwnershipPeriod): string {
  const span = PERIOD_SPAN[period];
  if (reading === "period") return `Each point is how many lines were gained or lost that ${span}.`;
  if (period === "day") return "Each point is the lines owned that day. Days without commits keep the previous totals.";
  return `Each point is the lines owned on the last day of that ${span}.`;
}

/** The old menu stored the bucket size in the same key as cumulative. Those
 * choices were end-of-period levels, so they come back as cumulative. */
function storedTimeline(): { reading: OwnershipReading; period: OwnershipPeriod } {
  const savedReading = localStorage.getItem("github-monitor.ownership.reading");
  const reading: OwnershipReading = savedReading === "period" ? "period" : "cumulative";
  const savedPeriod = localStorage.getItem("github-monitor.ownership.period");
  if (savedPeriod === "day" || savedPeriod === "week" || savedPeriod === "month" || savedPeriod === "quarter") {
    return { reading, period: savedPeriod };
  }
  const legacy = localStorage.getItem("github-monitor.ownership.timeline");
  const period: OwnershipPeriod = legacy === "week" || legacy === "month" || legacy === "quarter" ? legacy : "day";
  return { reading, period };
}

function storedChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = localStorage.getItem(key);
  return allowed.includes(value as T) ? value as T : fallback;
}

function remember<T>(key: string, value: T, set: (value: T) => void) {
  localStorage.setItem(key, String(value));
  set(value);
}

/** Daily first-parent history. Person grouping is fixed because that is what was saved. */
export function OwnershipHistoryChart({ points, selectedLogins, repositories }: {
  points: OwnershipHistoryPoint[];
  selectedLogins: readonly string[];
  repositories: Array<{ id: number; name: string }>;
}) {
  const [shape, setShape] = useState<TimelineShape>(() => storedChoice("github-monitor.ownership.shape", ["bar", "area", "line"], "area"));
  const [split, setSplit] = useState<OwnershipHistorySplit>(() => storedChoice("github-monitor.ownership.split", ["people", "repository", "total"], "people"));
  const [seriesLimit, setSeriesLimit] = useState(() => storedChoice("github-monitor.ownership.seriesLimit", ["4", "6", "8", "all"], "8"));
  const [stackMode, setStackMode] = useState<"stacked" | "overlaid">(() => storedChoice("github-monitor.ownership.stackMode", ["stacked", "overlaid"], "stacked"));
  const [values, setValues] = useState<"total" | "share">(() => storedChoice("github-monitor.ownership.valueMode", ["total", "share"], "total"));
  const [reading, setReading] = useState<OwnershipReading>(() => storedTimeline().reading);
  const [period, setPeriod] = useState<OwnershipPeriod>(() => storedTimeline().period);
  const [activeKeys, setActiveKeys] = useState<Set<string>>(() => new Set());
  const chooseReading = useCallback((value: OwnershipReading) => remember("github-monitor.ownership.reading", value, setReading), []);
  const choosePeriod = useCallback((value: OwnershipPeriod) => remember("github-monitor.ownership.period", value, setPeriod), []);
  const repoNames = useMemo(() => new Map(repositories.map((repo) => [repo.id, repo.name])), [repositories]);
  const { data, series } = useMemo(
    () => ownershipHistorySeries(points, selectedLogins, {
      split,
      limit: seriesLimit === "all" ? Number.POSITIVE_INFINITY : Number(seriesLimit),
      repoNames,
    }),
    [points, selectedLogins, split, seriesLimit, repoNames],
  );
  const plotted = useMemo(
    () => ownershipHistoryBuckets(data, series.map((item) => item.key), period, reading),
    [data, series, period, reading],
  );
  const singleSeries = split === "total";
  const toggleKey = (key: string) => setActiveKeys((prev) => {
    if (prev.size === 0) return new Set([key]);
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  if (!data.length) return null;
  const changed = shape !== "area" || split !== "people" || seriesLimit !== "8" || stackMode !== "stacked" || values !== "total";
  const periodLabel = (week: number) => period === "day" ? formatDate(week * 1000) : bucketLabel(week, period);
  return (
    <ChartCard title="Ownership over time"
      subtitle={`Credited lines on the default branch. ${historyCaption(reading, period)} Co-authors each receive full credit, so stacked people can exceed surviving lines.`}
      titleAfter={<>
        <ViewSelector ariaLabel="ownership reading" value={reading} options={HISTORY_READINGS} onChange={chooseReading} keyboardNav />
        <ViewSelector ariaLabel="aggregation period" value={period} options={HISTORY_PERIODS} onChange={choosePeriod} />
        <FilterPopover active={changed} width={356}>
        <Segmented ariaLabel="Chart shape" stretch value={shape} options={HISTORY_SHAPES} onChange={(value) => remember("github-monitor.ownership.shape", value, setShape)} />
        <LabeledControl label="Split by">
          <Segmented ariaLabel="Split ownership" variant="bare" stretch value={split} options={HISTORY_SPLITS} onChange={(value) => remember("github-monitor.ownership.split", value, setSplit)} />
        </LabeledControl>
        <LabeledControl label="Show">
          <Segmented ariaLabel="Series before Other" variant="bare" stretch value={seriesLimit} options={HISTORY_LIMITS} disabled={singleSeries} onChange={(value) => remember("github-monitor.ownership.seriesLimit", value, setSeriesLimit)} />
        </LabeledControl>
        {seriesLimit === "all" && !singleSeries ? <p className="px-0.5 text-[11px] text-ink-muted">Past eight series the colours repeat — the legend and tooltip still name each one.</p> : null}
        <Segmented ariaLabel="Stacking" stretch value={stackMode} options={HISTORY_STACKS} disabled={singleSeries} onChange={(value) => remember("github-monitor.ownership.stackMode", value, setStackMode)} />
        <Segmented ariaLabel="Values" stretch value={values} options={HISTORY_VALUES} disabled={singleSeries} onChange={(value) => remember("github-monitor.ownership.valueMode", value, setValues)} />
      </FilterPopover>
      </>}
      table={series.length ? <DataTable rows={plotted} rowKey={(row) => String(row.week)} maxHeight={420} initialSort={{ key: "day", dir: "asc" }} columns={[
        { key: "day", header: "Period", render: (row) => periodLabel(row.week), sortValue: (row) => row.week },
        ...series.map((item) => ({
          key: item.key,
          header: item.label,
          align: "right" as const,
          render: (row: Record<string, number>) => full(row[item.key] ?? 0),
          sortValue: (row: Record<string, number>) => row[item.key] ?? 0,
        })),
      ]} /> : undefined}>
      {series.length === 0
        ? <p className="text-[12px] text-ink-muted">No surviving lines match these filters.</p>
        : <TimelineArea data={plotted} series={series} shape={shape} stackMode={stackMode} values={values} height={280}
          withBrush={plotted.length > 45} activeKeys={activeKeys} onToggleKey={toggleKey}
          valueLabel={values === "share" ? (reading === "period" ? "of that period's change" : "of credited lines") : "lines"} labelOf={periodLabel} />}
    </ChartCard>
  );
}

/** All views use the same globally resolved identities and surviving-line base. */
export function LineOwnershipCharts({ summary, repositories }: {
  summary: Summary;
  /** Same order as the reports passed to aggregateOwnership. */
  repositories: Array<{ id: number; name: string }>;
}) {
  const [measure, setMeasure] = useState<"share" | "lines">("share");
  const [limit, setLimit] = useState<"12" | "24" | "all">("12");
  const repoRows = useMemo(() => repositories.map((repo, i) => {
    const data = summary.byRepository[i];
    return { ...repo, ...data, topAuthor: data.authors[0]?.author ?? "—", topShare: data.authors[0]?.share ?? 0 };
  }).sort((a, b) => b.topShare - a.topShare || b.totalLines - a.totalLines || a.name.localeCompare(b.name)), [summary, repositories]);
  const topAuthors = summary.authors.slice(0, 12);
  const topRepos = repoRows.filter((r) => r.totalLines > 0).slice(0, 12);
  const matrix = useMemo(() => {
    const count = limit === "all" ? Infinity : Number(limit);
    const people = summary.authors.slice(0, count);
    const repos = [...repoRows].filter((r) => r.totalLines > 0)
      .sort((a, b) => b.totalLines - a.totalLines || a.name.localeCompare(b.name)).slice(0, count);
    const byRepo = repos.map((repo) => new Map(repo.authors.map((a) => [a.key, a])));
    const cellAt = (row: number, col: number) => byRepo[col].get(people[row].key);
    const values = people.map((_, row) => repos.map((__, col) => cellAt(row, col)?.[measure] ?? 0));
    return { people, repos, cellAt, values };
  }, [summary, repoRows, limit, measure]);
  const cells = useMemo(() => repoRows.flatMap((repo) => repo.authors.map((author) => ({
    ...author, repoId: repo.id, repository: repo.name,
  }))), [repoRows]);

  return <>
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <ChartCard title="Top owners"
        subtitle={`${topAuthors.length < summary.authors.length ? `Top ${topAuthors.length} of ${full(summary.authors.length)} identities` : "Every credited identity"} · share of surviving lines`}
        table={<DataTable rows={summary.authors} rowKey={(a) => a.key} maxHeight={400} initialSort={{ key: "lines", dir: "desc" }} empty="No surviving lines match these filters." columns={[
          { key: "author", header: "Author", render: (a) => a.author, sortValue: (a) => a.author },
          { key: "lines", header: "Lines", align: "right", render: (a) => full(a.lines), sortValue: (a) => a.lines },
          { key: "share", header: "Share", align: "right", render: (a) => share(a.share), sortValue: (a) => a.share },
          { key: "aliases", header: "Names / emails", render: (a) => <span className="whitespace-normal break-all text-ink-secondary">{[...a.names, ...a.emails].join(" · ")}</span> },
        ]} />}>
        <RankedBars data={topAuthors.map((a) => ({ name: a.author, value: a.share * 100 }))} height={360}
          domain={[0, 100]} showAxis labelWidth={160} truncateLabels valueLabel="of surviving lines" valueFormatter={percent} />
      </ChartCard>
      <ChartCard title="Repository concentration"
        subtitle="Highest top-owner shares · all repositories are available in the table"
        table={<DataTable rows={repoRows} rowKey={(r) => r.id} maxHeight={400} initialSort={{ key: "share", dir: "desc" }} columns={[
          { key: "repo", header: "Repository", render: (r) => r.name, sortValue: (r) => r.name },
          { key: "owner", header: "Top owner", render: (r) => r.topAuthor },
          { key: "share", header: "Top-owner share", align: "right", render: (r) => r.totalLines ? share(r.topShare) : "—", sortValue: (r) => r.topShare },
          { key: "lines", header: "Surviving lines", align: "right", render: (r) => full(r.totalLines), sortValue: (r) => r.totalLines },
          { key: "people", header: "People", align: "right", render: (r) => full(r.authors.length), sortValue: (r) => r.authors.length },
        ]} />}>
        <RankedBars data={topRepos.map((r) => ({ name: r.name, value: r.topShare * 100 }))} height={360}
          domain={[0, 100]} showAxis labelWidth={160} truncateLabels valueLabel="credited to the top owner" valueFormatter={percent} />
      </ChartCard>
    </div>
    <p className="text-[12px] text-ink-muted">Co-authors each receive full credit, so author shares can add up to more than 100%. Repository concentration shows one person’s share of that repository’s surviving lines.</p>
    <ChartCard title="People × repositories"
      subtitle={`${full(matrix.people.length)} of ${full(summary.authors.length)} identities · ${full(matrix.repos.length)} of ${full(repoRows.filter((r) => r.totalLines > 0).length)} repositories with lines · ${measure === "share" ? "colour shows share within each repository" : "colour shows credited lines"}`}
      titleAfter={<div className="flex flex-wrap gap-2">
        <Segmented ariaLabel="Heatmap measure" value={measure} onChange={setMeasure} options={[{ value: "share", label: "Share" }, { value: "lines", label: "Lines" }]} />
        <select aria-label="Heatmap size" value={limit} onChange={(e) => setLimit(e.target.value as typeof limit)} className="h-7 rounded-md border border-hairline bg-surface px-2 text-[11px] text-ink">
          <option value="12">Top 12</option><option value="24">Top 24</option><option value="all">All</option>
        </select>
      </div>}
      table={<DataTable rows={cells} rowKey={(r) => `${r.repoId}:${r.key}`} maxHeight={420} initialSort={{ key: "lines", dir: "desc" }} empty="No surviving lines match these filters." columns={[
        { key: "author", header: "Author", render: (r) => r.author, sortValue: (r) => r.author },
        { key: "repo", header: "Repository", render: (r) => r.repository, sortValue: (r) => r.repository },
        { key: "lines", header: "Lines", align: "right", render: (r) => full(r.lines), sortValue: (r) => r.lines },
        { key: "share", header: "Repository share", align: "right", render: (r) => share(r.share), sortValue: (r) => r.share },
      ]} />}>
      <HeatMatrix rowLabels={matrix.people.map((p) => p.author)} columnLabels={matrix.repos.map((r) => shortRepo(r.name))}
        values={matrix.values} cellSize={28} cellWidth={96} gap={3} maxHeight={480}
        scaleMax={measure === "share" ? 1 : undefined} legendFormatter={measure === "share" ? share : full}
        headerTooltip={(axis, index) => axis === "row" ? {
          heading: matrix.people[index].author,
          rows: [{ label: "lines across selected repositories", value: full(matrix.people[index].lines) }],
        } : {
          heading: matrix.repos[index].name,
          rows: [{ label: "surviving lines", value: full(matrix.repos[index].totalLines) }, { label: "top owner", value: matrix.repos[index].topAuthor }],
        }}
        cellTooltip={(_, row, col) => ({
          heading: `${matrix.people[row].author} · ${matrix.repos[col].name}`,
          rows: [{ label: "credited lines", value: full(matrix.cellAt(row, col)?.lines ?? 0) }, { label: "of this repository", value: share(matrix.cellAt(row, col)?.share ?? 0) }],
        })} />
    </ChartCard>
  </>;
}
