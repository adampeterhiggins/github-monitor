import { memo, Profiler, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { bucketLabel } from "../lib/agg/series";
import { formatDate } from "../lib/agg/weeks";
import {
  coarsenPlotRows, ownershipHistoryBuckets, plotBudget, projectOwnershipHistory, resolveOwnershipPeople,
  type OwnershipHistorySeries, type OwnershipHistorySplit, type OwnershipPeriod, type OwnershipReading, type OwnershipSummary,
} from "../lib/lineOwnership";
import type { NormalizedRepoHistory } from "../lib/ownershipHistory";
import { selectOwnershipPeople, type OwnershipAccountIndex } from "../lib/ownershipIdentity";
import { measure, profileRender } from "../lib/perf";
import { HeatMatrix, RankedBars, TimelineArea, type TimelineShape } from "./charts";
import { Button, ChartCard, Checkbox, DataTable, FilterPopover, LabeledControl, Segmented, Spinner, full } from "./ui";

type Summary = OwnershipSummary;
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
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
];
const PERIOD_SPAN = { day: "day", week: "week", month: "month", quarter: "quarter" } as const;
const Y_AXES = [
  { value: "full" as const, label: "Full" },
  { value: "fit" as const, label: "Fit to data" },
];
const REPO_LABELS = [
  { value: "full" as const, label: "owner/name" },
  { value: "name" as const, label: "Name only" },
];

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

/** Width of an element, following resizes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Past this many plotted marks, animating a change costs more than it shows. */
const MAX_ANIMATED_MARKS = 6000;
/** Recharts' default area and line animation is 1.5 s. */
const ANIMATION_WINDOW_MS = 1600;

/** The plotted series. Memoised so a control change can paint before Recharts
 * rebuilds the marks. */
const HistoryPlot = memo(function HistoryPlot({
  plotted, series, shape, stackMode, values, reading, labelOf, withBrush, onBrushChange, activeKeys, onToggleKey, animate, yFit, hideOther,
}: {
  plotted: Array<Record<string, number>>;
  series: OwnershipHistorySeries["series"];
  shape: TimelineShape;
  stackMode: "stacked" | "overlaid";
  values: "total" | "share";
  reading: OwnershipReading;
  labelOf: (week: number) => string;
  withBrush: boolean;
  onBrushChange: (range: { startIndex: number; endIndex: number }) => void;
  activeKeys: Set<string>;
  onToggleKey: (key: string) => void;
  animate: boolean;
  yFit: boolean;
  hideOther: boolean;
}) {
  return series.length === 0
    ? <p className="text-[12px] text-ink-muted">No surviving lines match these filters.</p>
    : <Profiler id="ownership-history" onRender={(id, phase, duration) => profileRender(id, phase, duration)}>
      <TimelineArea data={plotted} series={series} shape={shape} stackMode={stackMode} values={values} height={280}
        withBrush={withBrush} onBrushChange={onBrushChange} activeKeys={activeKeys} onToggleKey={onToggleKey} animate={animate} yFit={yFit} hideOther={hideOther}
        valueLabel={values === "share" ? (reading === "period" ? "of that period's change" : "of credited lines") : "lines"} labelOf={labelOf} />
    </Profiler>;
});

/**
 * Daily first-parent history. People are resolved to GitHub accounts once per
 * repository selection and account revision; the contributor selection, split,
 * period and shape reuse that work. The table always holds exact periods; only the
 * plot is coarsened to what its width can show.
 */
export function OwnershipHistoryChart({ histories, selectedLogins, repositories, accounts, loading, window }: {
  histories: readonly NormalizedRepoHistory[];
  selectedLogins: readonly string[];
  repositories: Array<{ id: number; name: string }>;
  accounts?: OwnershipAccountIndex;
  loading?: boolean;
  /** The page's period. Null shows all history. */
  window?: { fromMs: number; toMs: number } | null;
}) {
  const [shape, setShape] = useState<TimelineShape>(() => storedChoice("github-monitor.ownership.shape", ["bar", "area", "line"], "area"));
  const [split, setSplit] = useState<OwnershipHistorySplit>(() => storedChoice("github-monitor.ownership.split", ["people", "repository", "total"], "people"));
  const [seriesLimit, setSeriesLimit] = useState(() => storedChoice("github-monitor.ownership.seriesLimit", ["4", "6", "8", "all"], "8"));
  const [stackMode, setStackMode] = useState<"stacked" | "overlaid">(() => storedChoice("github-monitor.ownership.stackMode", ["stacked", "overlaid"], "stacked"));
  const [values, setValues] = useState<"total" | "share">(() => storedChoice("github-monitor.ownership.valueMode", ["total", "share"], "total"));
  const [hideOther, setHideOther] = useState(() => storedChoice("github-monitor.ownership.hideOther", ["true", "false"], "false") === "true");
  const [yAxis, setYAxis] = useState<"full" | "fit">(() => storedChoice("github-monitor.ownership.yAxis", ["full", "fit"], "full"));
  const [repoLabel, setRepoLabel] = useState<"full" | "name">(() => storedChoice("github-monitor.ownership.repoLabel", ["full", "name"], "full"));
  const [reading, setReading] = useState<OwnershipReading>(() => storedTimeline().reading);
  const [period, setPeriod] = useState<OwnershipPeriod>(() => storedTimeline().period);
  const [activeKeys, setActiveKeys] = useState<Set<string>>(() => new Set());
  const [zoom, setZoom] = useState<{ from: number; to: number } | null>(null);
  const [plotRef, width] = useWidth<HTMLDivElement>();
  const chooseReading = useCallback((value: OwnershipReading) => remember("github-monitor.ownership.reading", value, setReading), []);
  const choosePeriod = useCallback((value: OwnershipPeriod) => { setZoom(null); remember("github-monitor.ownership.period", value, setPeriod); }, []);
  const toggleKey = useCallback((key: string) => setActiveKeys((prev) => {
    if (prev.size === 0) return new Set([key]);
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }), []);
  const deferredSplit = useDeferredValue(split);
  const deferredLimit = useDeferredValue(seriesLimit);
  const deferredReading = useDeferredValue(reading);
  const deferredPeriod = useDeferredValue(period);
  const deferredShape = useDeferredValue(shape);
  const deferredStack = useDeferredValue(stackMode);
  const deferredValues = useDeferredValue(values);
  const repoNames = useMemo(
    () => new Map(repositories.map((repo) => [repo.id, repoLabel === "name" ? shortRepo(repo.name) : repo.name])),
    [repositories, repoLabel],
  );
  // Rebuilt only when the repositories or account mappings change.
  const identity = useMemo(() => measure("ownership:identity", () => resolveOwnershipPeople(histories, accounts)), [histories, accounts]);
  const selection = useMemo(() => measure("ownership:selection", () => selectOwnershipPeople(identity.index, selectedLogins)), [identity, selectedLogins]);
  const { data, series } = useMemo(
    () => measure("ownership:sweep", () => projectOwnershipHistory(histories, identity, selection, {
      split: deferredSplit,
      limit: deferredLimit === "all" ? Number.POSITIVE_INFINITY : Number(deferredLimit),
      repoNames,
    })),
    [histories, identity, selection, deferredSplit, deferredLimit, repoNames],
  );
  const keys = useMemo(() => series.map((item) => item.key), [series]);
  // Exact periods for the table, export and lookup.
  const fullRows = useMemo(
    () => measure("ownership:buckets", () => ownershipHistoryBuckets(data, keys, deferredPeriod, deferredReading)),
    [data, keys, deferredPeriod, deferredReading],
  );
  // The page period, applied after bucketing so a per-period reading keeps each
  // period's real change instead of measuring the first one from zero.
  const fromMs = window?.fromMs ?? null;
  const toMs = window?.toMs ?? null;
  const periodRows = useMemo(() => {
    if (fromMs == null || toMs == null) return fullRows;
    // Keep the bucket that contains the start as well as those that begin inside.
    let first = 0;
    for (let i = 0; i < fullRows.length; i++) if (fullRows[i].week * 1000 <= fromMs) first = i;
    return fullRows.slice(first).filter((row) => row.week * 1000 <= toMs);
  }, [fullRows, fromMs, toMs]);
  // A zoom belongs to the period it was made in.
  useEffect(() => { setZoom(null); }, [fromMs, toMs]);
  const visibleRows = useMemo(
    () => zoom ? periodRows.filter((row) => row.week >= zoom.from && row.week <= zoom.to) : periodRows,
    [periodRows, zoom],
  );
  const budget = plotBudget(width, deferredShape);
  const plot = useMemo(
    () => measure("ownership:plot", () => coarsenPlotRows(visibleRows, keys, budget, deferredReading)),
    [visibleRows, keys, budget, deferredReading],
  );
  const plotStale = deferredSplit !== split || deferredLimit !== seriesLimit || deferredReading !== reading
    || deferredPeriod !== period || deferredShape !== shape || deferredStack !== stackMode || deferredValues !== values;
  const singleSeries = split === "total";
  const waiting = histories.every((h) => h.days.length === 0);
  const changed = hideOther || yAxis !== "full" || repoLabel !== "full" || shape !== "area" || split !== "people" || seriesLimit !== "8" || stackMode !== "stacked" || values !== "total" || reading !== "cumulative" || period !== "day";
  const periodLabel = useCallback((week: number) => deferredPeriod === "day" ? formatDate(week * 1000) : bucketLabel(week, deferredPeriod), [deferredPeriod]);
  const plotLabel = useCallback((week: number) => {
    const end = plot.ends.get(week);
    return end != null && end !== week ? `${periodLabel(week)} – ${periodLabel(end)}` : periodLabel(week);
  }, [plot, periodLabel]);
  // Dragging the brush zooms once it settles; the zoomed plot restores detail.
  const brushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onBrushChange = useCallback(({ startIndex, endIndex }: { startIndex: number; endIndex: number }) => {
    if (brushTimer.current) clearTimeout(brushTimer.current);
    brushTimer.current = setTimeout(() => {
      const rows = plot.rows;
      if (startIndex <= 0 && endIndex >= rows.length - 1) return;
      const from = rows[Math.max(0, startIndex)]?.week;
      const last = rows[Math.min(rows.length - 1, endIndex)]?.week;
      if (from != null && last != null) setZoom({ from, to: plot.ends.get(last) ?? last });
    }, 450);
  }, [plot]);
  useEffect(() => () => { if (brushTimer.current) clearTimeout(brushTimer.current); }, []);
  const span = PERIOD_SPAN[deferredPeriod];
  const partial = histories.filter((h) => h.partial).length;
  // Animate when the chart appears and when the reader changes what it shows.
  // Days saved in the background during a sync redraw in place: animating each
  // refresh would replay the transition over and over. Dense plots never animate.
  const viewKey = [
    waiting || series.length === 0 ? "empty" : "ready", deferredShape, deferredSplit, deferredLimit, deferredStack,
    deferredValues, deferredReading, deferredPeriod, zoom?.from, zoom?.to, fromMs, toMs, yAxis, hideOther, selectedLogins.join("\0"),
    repositories.map((r) => r.id).join(","),
  ].join("|");
  // Held for the length of Recharts' animation, so a re-render moments after the
  // change (a loading flag clearing) does not cut the transition short.
  const viewChanged = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });
  if (viewChanged.current.key !== viewKey) viewChanged.current = { key: viewKey, at: Date.now() };
  const animate = Date.now() - viewChanged.current.at < ANIMATION_WINDOW_MS
    && plot.rows.length * Math.max(1, series.length) <= MAX_ANIMATED_MARKS;
  return (
    <ChartCard title="Ownership over time" loading={loading || plotStale || waiting}
      subtitle={`Credited lines on the default branch. ${historyCaption(reading, period)} Co-authors who are different people each receive full credit, so stacked people can exceed surviving lines.`}
      titleAfter={
        <FilterPopover active={changed} width={356}>
        <LabeledControl label="Reading">
          <Segmented ariaLabel="Ownership reading" variant="bare" stretch value={reading} options={HISTORY_READINGS} onChange={chooseReading} />
        </LabeledControl>
        <LabeledControl label="Period">
          <Segmented ariaLabel="Aggregation period" variant="bare" stretch value={period} options={HISTORY_PERIODS} onChange={choosePeriod} />
        </LabeledControl>
        <Segmented ariaLabel="Chart shape" stretch value={shape} options={HISTORY_SHAPES} onChange={(value) => remember("github-monitor.ownership.shape", value, setShape)} />
        <LabeledControl label="Split by">
          <Segmented ariaLabel="Split ownership" variant="bare" stretch value={split} options={HISTORY_SPLITS} onChange={(value) => remember("github-monitor.ownership.split", value, setSplit)} />
        </LabeledControl>
        <LabeledControl label="Y axis">
          <Segmented ariaLabel="Y axis range" variant="bare" stretch value={yAxis} options={Y_AXES} onChange={(value) => remember("github-monitor.ownership.yAxis", value, setYAxis)} />
        </LabeledControl>
        <LabeledControl label="Repository names">
          <Segmented ariaLabel="Repository names" variant="bare" stretch value={repoLabel} options={REPO_LABELS} disabled={split !== "repository"} onChange={(value) => remember("github-monitor.ownership.repoLabel", value, setRepoLabel)} />
        </LabeledControl>
        <LabeledControl label="Show">
          <Segmented ariaLabel="Series before Other" variant="bare" stretch value={seriesLimit} options={HISTORY_LIMITS} disabled={singleSeries} onChange={(value) => remember("github-monitor.ownership.seriesLimit", value, setSeriesLimit)} />
        </LabeledControl>
        <Checkbox checked={hideOther} disabled={singleSeries || seriesLimit === "all"}
          onChange={(value) => remember("github-monitor.ownership.hideOther", value, setHideOther)}
          label={<span className="text-ink-secondary" title="Other stays in every share and total; it is only not drawn">Hide Other</span>} />
        {seriesLimit === "all" && !singleSeries ? <p className="px-0.5 text-[11px] text-ink-muted">Every series is drawn. Past eight the colours repeat — the legend and tooltip still name each one.</p> : null}
        <Segmented ariaLabel="Stacking" stretch value={stackMode} options={HISTORY_STACKS} disabled={singleSeries} onChange={(value) => remember("github-monitor.ownership.stackMode", value, setStackMode)} />
        <Segmented ariaLabel="Values" stretch value={values} options={HISTORY_VALUES} disabled={singleSeries} onChange={(value) => remember("github-monitor.ownership.valueMode", value, setValues)} />
        </FilterPopover>
      }
      table={series.length ? <DataTable rows={periodRows} rowKey={(row) => String(row.week)} maxHeight={420} initialSort={{ key: "day", dir: "asc" }} columns={[
        { key: "day", header: "Period", render: (row) => periodLabel(row.week), sortValue: (row) => row.week },
        ...series.map((item) => ({
          key: item.key,
          header: item.label,
          align: "right" as const,
          render: (row: Record<string, number>) => full(row[item.key] ?? 0),
          sortValue: (row: Record<string, number>) => row[item.key] ?? 0,
        })),
      ]} /> : undefined}>
      <div ref={plotRef}>
        {waiting ? (
          <div className="flex h-[280px] items-center justify-center gap-2 text-[12px] text-ink-muted" role="status">
            <Spinner /> Calculating ownership history…
          </div>
        ) : (
          <HistoryPlot plotted={plot.rows} series={series} shape={deferredShape} stackMode={deferredStack} values={deferredValues}
            reading={deferredReading} labelOf={plotLabel} withBrush={plot.rows.length > 1} onBrushChange={onBrushChange}
            activeKeys={activeKeys} onToggleKey={toggleKey} animate={animate} yFit={yAxis === "fit"} hideOther={hideOther} />
        )}
      </div>
      {(plot.factor > 1 || zoom || partial > 0) && <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
        {plot.factor > 1 && <span role="note">Plotted at {plot.factor}-{span} resolution{deferredReading === "cumulative" ? ", each point the level at the end of its range" : ", each point the change across its range"}. Drag the handles below the chart to zoom in for {span} detail. The table lists every {span}.</span>}
        {zoom && <><span>Showing {periodLabel(zoom.from)} – {periodLabel(zoom.to)}.</span><Button variant="ghost" onClick={() => setZoom(null)}>Reset zoom</Button></>}
        {partial > 0 && <span>History for {full(partial)} {partial === 1 ? "repository is" : "repositories are"} still being recorded, so the latest day may change.</span>}
      </div>}
    </ChartCard>
  );
}

/** All views use the same globally resolved identities and surviving-line base. */
export function LineOwnershipCharts({ summary, repositories, loading }: {
  summary: Summary;
  /** Same order as the reports passed to aggregateOwnership. */
  repositories: Array<{ id: number; name: string }>;
  loading?: boolean;
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
      <ChartCard title="Top owners" loading={loading}
        subtitle={`${topAuthors.length < summary.authors.length ? `Top ${topAuthors.length} of ${full(summary.authors.length)} identities` : "Every credited identity"} · share of surviving lines`}
        table={<DataTable rows={summary.authors} rowKey={(a) => a.key} maxHeight={400} initialSort={{ key: "lines", dir: "desc" }} empty="No surviving lines match these filters." columns={[
          { key: "author", header: "Author", render: (a) => a.author, sortValue: (a) => a.author },
          { key: "lines", header: "Lines", align: "right", render: (a) => full(a.lines), sortValue: (a) => a.lines },
          { key: "share", header: "Share", align: "right", render: (a) => share(a.share), sortValue: (a) => a.share },
          { key: "account", header: "Account", render: (a) => a.matched == null ? "—" : a.matched
            ? <span title={a.githubId ? `GitHub ID ${a.githubId}` : "Login from a noreply address; no account ID yet"}>@{a.login}{a.sources.includes("manual") ? " · Manual" : " · GitHub"}</span>
            : <span className="text-ink-muted">Unmatched Git identity</span>, sortValue: (a) => a.login ?? "" },
          { key: "aliases", header: "Names / emails", render: (a) => <span className="whitespace-normal break-all text-ink-secondary">{[...a.names, ...a.emails].join(" · ")}</span> },
        ]} />}>
        <RankedBars data={topAuthors.map((a) => ({ name: a.author, value: a.share * 100 }))} height={360}
          domain={[0, 100]} showAxis labelWidth={160} truncateLabels valueLabel="of surviving lines" valueFormatter={percent} />
      </ChartCard>
      <ChartCard title="Repository concentration" loading={loading}
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
    <ChartCard title="People × repositories" loading={loading}
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
