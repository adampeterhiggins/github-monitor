import { useDeferredValue, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  breakdownOwnership, foldSlices, loadOwnershipBreakdown, AGE_BANDS,
  type BreakdownSlice, type BreakdownSplit,
} from "../lib/ownershipBreakdown";
import { selectOwnershipPeople, type OwnershipIdentityIndex } from "../lib/ownershipIdentity";
import type { OwnershipRevision } from "../lib/db/lineOwnership";
import { useVizPalette } from "../lib/viz/useVizPalette";
import { OTHER_COLOR, seriesColor, seriesColorCycled, type VizPalette } from "../lib/viz/palette";
import { formatDate } from "../lib/agg/weeks";
import { DonutChart, HeatMatrix, RankedBars, TreemapChart, type PartDatum } from "./charts";
import { Callout, ChartCard, DataTable, Segmented, Spinner, StatTile, full } from "./ui";

type Form = "donut" | "bars" | "treemap";

const SPLITS: Array<{ value: BreakdownSplit; label: string }> = [
  { value: "person", label: "People" },
  { value: "language", label: "Language" },
  { value: "directory", label: "Directory" },
  { value: "file", label: "File" },
  { value: "age", label: "Line age" },
];
const FORMS: Array<{ value: Form; label: string }> = [
  { value: "donut", label: "Donut" },
  { value: "bars", label: "Bars" },
  { value: "treemap", label: "Treemap" },
];
/** A donut compares at most six parts; past that it is a table's job. */
const KEEP: Record<Form, number> = { donut: 6, bars: 16, treemap: 40 };
const SPLIT_NOUN: Record<BreakdownSplit, string> = {
  person: "person", language: "language", directory: "directory", file: "file", age: "age band",
};

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const shortRepo = (name: string) => name.slice(name.lastIndexOf("/") + 1);

function storedChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = localStorage.getItem(key);
  return allowed.includes(value as T) ? value as T : fallback;
}

function ageText(days: number | null): string {
  if (days == null) return "—";
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 730) return `${Math.round(days / 30.4)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}

/**
 * Ordinal bands step along the sequential ramp, youngest lightest. Other slices
 * use categorical slots by rank; past the eighth the treemap repeats hues, since
 * every cell is labelled, and the other forms fold the tail into Other.
 */
function sliceColor(palette: VizPalette, split: BreakdownSplit, slice: BreakdownSlice, index: number, cycle: boolean): string {
  if (slice.key === "other" || slice.key === "age:none") return OTHER_COLOR[palette.mode];
  if (split === "age") {
    const band = AGE_BANDS.findIndex((b) => b.key === slice.key);
    const steps = palette.sequential.length;
    // No lighter than index 3, so the youngest band stays visible on the surface.
    return palette.sequential[Math.round(3 + (band / (AGE_BANDS.length - 1)) * (steps - 4))];
  }
  return cycle ? seriesColorCycled(palette, index) : seriesColor(palette, index) ?? OTHER_COLOR[palette.mode];
}

/**
 * One repository's surviving lines, split by person, language, directory,
 * file or age. Directories drill down; every split then applies inside that
 * directory. Reads the saved per-file cache on demand.
 */
export function OwnershipInspector({ rows, identity, selectedLogins, repoId, onRepoChange }: {
  rows: readonly OwnershipRevision[];
  identity: OwnershipIdentityIndex;
  selectedLogins: readonly string[];
  repoId: number | null;
  onRepoChange: (repoId: number) => void;
}) {
  const palette = useVizPalette();
  const [split, setSplit] = useState<BreakdownSplit>(() => storedChoice("github-monitor.inspect.split", SPLITS.map((s) => s.value), "person"));
  const [form, setForm] = useState<Form>(() => storedChoice("github-monitor.inspect.form", FORMS.map((f) => f.value), "donut"));
  const [scope, setScope] = useState<{ repoId: number | null; prefix: string }>({ repoId: null, prefix: "" });
  const choices = rows.filter((row) => row.hasReport);
  const row = choices.find((r) => r.repoId === repoId) ?? choices[0] ?? null;
  const prefix = scope.repoId === row?.repoId ? scope.prefix : "";
  const setPrefix = (next: string) => setScope({ repoId: row?.repoId ?? null, prefix: next });

  const breakdown = useQuery({
    queryKey: ["line-ownership-breakdown", row?.repoId, row?.cacheRef],
    enabled: row?.cacheRef != null,
    queryFn: () => loadOwnershipBreakdown(row!.fullName, row!.cacheRef!),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
  const data = breakdown.data;
  const deferredSplit = useDeferredValue(split);
  const deferredPrefix = useDeferredValue(prefix);
  const deferredLogins = useDeferredValue(selectedLogins);
  const result = useMemo(() => {
    if (!data || !row) return null;
    return breakdownOwnership(data, {
      split: deferredSplit, identity, repoId: row.repoId, prefix: deferredPrefix,
      selection: selectOwnershipPeople(identity, deferredLogins),
    });
  }, [data, row, deferredSplit, deferredPrefix, identity, deferredLogins]);
  const stale = breakdown.isFetching || deferredSplit !== split || deferredPrefix !== prefix || deferredLogins !== selectedLogins;

  const shown = useMemo(() => {
    if (!result) return [];
    const folded = deferredSplit === "age" ? result.slices : foldSlices(result.slices, KEEP[form], result.totalLines);
    return folded.map((slice, i): PartDatum & { slice: BreakdownSlice } => ({
      key: slice.key, name: slice.label, value: slice.lines, color: sliceColor(palette, deferredSplit, slice, i, form === "treemap"), slice,
      detail: [
        { label: slice.files === 1 ? "file" : "files", value: full(slice.files) },
        ...(slice.people ? [{ label: slice.people === 1 ? "person" : "people", value: full(slice.people) }] : []),
        ...(slice.directory ? [{ label: "click to open", value: "↳" }] : []),
      ],
    }));
  }, [result, deferredSplit, form, palette]);
  const drill = (datum: PartDatum) => {
    const directory = (datum as PartDatum & { slice?: BreakdownSlice }).slice?.directory;
    if (!directory) return false;
    setPrefix(directory);
    return true;
  };
  const crumbs = prefix.split("/").filter(Boolean);
  const matrixSlices = result ? result.slices.slice(0, 12) : [];

  if (!choices.length) return null;
  const repoName = row?.fullName ?? "";
  const byPerson = deferredSplit === "person";
  const unit = byPerson ? "lines (co-authored lines divided)" : "surviving lines";

  return (
    <section className="space-y-3" aria-label="Inspect a repository">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold text-ink">Inspect a repository</h2>
        <select aria-label="Repository to inspect" value={row?.repoId ?? ""} onChange={(e) => onRepoChange(Number(e.target.value))}
          className="h-7 max-w-[320px] rounded-md border border-hairline bg-surface px-2 text-[12px] text-ink">
          {choices.map((r) => <option key={r.repoId} value={r.repoId}>{r.fullName}</option>)}
        </select>
        <nav aria-label="Directory" className="flex flex-wrap items-center gap-1 text-[12px]">
          <button className={prefix ? "text-accent hover:underline" : "font-medium text-ink"} onClick={() => setPrefix("")}>{shortRepo(repoName)}</button>
          {crumbs.map((part, i) => {
            const target = `${crumbs.slice(0, i + 1).join("/")}/`;
            const last = i === crumbs.length - 1;
            return <span key={target} className="flex items-center gap-1">
              <span className="text-ink-muted">/</span>
              <button className={last ? "font-medium text-ink" : "text-accent hover:underline"} disabled={last} onClick={() => setPrefix(target)}>{part}</button>
            </span>;
          })}
        </nav>
        {stale && <Spinner />}
      </div>

      {row && !row.cacheRef && <Callout tone="info">This repository's ownership was saved in an older format without per-file detail. Run Sync changes in Settings & sync to inspect it.</Callout>}
      {breakdown.error && <Callout tone="critical">Could not read this repository's ownership: {breakdown.error instanceof Error ? breakdown.error.message : String(breakdown.error)}</Callout>}
      {row?.cacheRef && !data && breakdown.isLoading && <div role="status" className="flex items-center gap-2 text-[12px] text-ink-secondary"><Spinner /> Reading saved ownership for {repoName}…</div>}

      {result && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile label="Surviving lines" value={full(result.totalLines)} hint={prefix ? `In ${prefix}` : "Whole repository"} />
          <StatTile label="Files" value={full(result.files)} hint="Text files with surviving lines" />
          <StatTile label="People" value={full(result.people)} hint={`${full(result.coauthoredLines)} co-authored lines`} />
          <StatTile label="Median line age" value={ageText(result.medianAgeDays)} hint="Half the lines are older than this" />
          <StatTile label="Oldest line" value={result.oldest ? formatDate(result.oldest) : "—"} hint={result.newest ? `Newest ${formatDate(result.newest)}` : "No dated commits"} />
        </div>

        <ChartCard title={`Lines by ${SPLIT_NOUN[split]}`} loading={stale}
          subtitle={<>
            {byPerson
              ? "Each person's part of the surviving lines. Co-authored lines are divided between their people, so the parts sum to the whole; the table also lists full credit."
              : split === "age" ? "Surviving lines by when they were written (author date of the commit that last touched each line)."
              : split === "language" ? "Surviving lines by file type, from each file's extension."
              : split === "directory" ? "Surviving lines per top-level directory. Click a directory to open it."
              : "The files holding the most surviving lines."}
            {form !== "bars" && split !== "age" && result.slices.length > KEEP[form] ? ` The smallest ${full(result.slices.length - KEEP[form] + 1)} are folded into Other; the table lists every one.` : ""}
          </>}
          titleAfter={<div className="flex flex-wrap gap-2">
            <Segmented ariaLabel="Split lines by" value={split} options={SPLITS}
              onChange={(value) => { localStorage.setItem("github-monitor.inspect.split", value); setSplit(value); }} />
            <Segmented ariaLabel="Chart form" value={form} options={FORMS}
              onChange={(value) => { localStorage.setItem("github-monitor.inspect.form", value); setForm(value); }} />
          </div>}
          table={<DataTable rows={result.slices} rowKey={(s) => s.key} maxHeight={420}
            initialSort={split === "age" ? undefined : { key: "lines", dir: "desc" }} empty="No surviving lines match these filters." columns={[
              { key: "label", header: split === "person" ? "Person" : split === "age" ? "Age" : split === "file" ? "File" : split === "directory" ? "Directory" : "Language",
                render: (s) => s.directory ? <button className="text-accent hover:underline" onClick={() => setPrefix(s.directory!)}>{s.label}</button> : <span className="break-all">{s.label}</span>,
                sortValue: (s) => s.label },
              { key: "lines", header: byPerson ? "Divided lines" : "Lines", align: "right", render: (s) => full(Math.round(s.lines)), sortValue: (s) => s.lines },
              { key: "share", header: "Share", align: "right", render: (s) => percent(s.share), sortValue: (s) => s.share },
              ...(byPerson ? [{ key: "credited", header: "Full credit", align: "right" as const, render: (s: BreakdownSlice) => full(s.creditedLines ?? 0), sortValue: (s: BreakdownSlice) => s.creditedLines ?? 0 }] : []),
              { key: "files", header: "Files", align: "right", render: (s) => full(s.files), sortValue: (s) => s.files },
              ...(!byPerson ? [{ key: "people", header: "People", align: "right" as const, render: (s: BreakdownSlice) => full(s.people), sortValue: (s: BreakdownSlice) => s.people }] : []),
            ]} />}>
          {form === "donut"
            ? <DonutChart data={shown} total={result.totalLines} totalLabel="lines" valueLabel={unit} onSelect={drill} />
            : form === "treemap"
              ? <TreemapChart data={shown} total={result.totalLines} valueLabel={unit} onSelect={drill} />
              : <RankedBars data={shown.map((d) => ({ name: d.name, value: Math.round(d.value) }))} valueLabel={unit} labelWidth={200} truncateLabels showAxis />}
        </ChartCard>

        {!byPerson && result.matrix.people.length > 0 && matrixSlices.length > 1 && <ChartCard title={`Who owns each ${SPLIT_NOUN[split]}`} loading={stale}
          subtitle={`Top ${full(result.matrix.people.length)} people × ${full(matrixSlices.length)} of ${full(result.slices.length)} ${split === "age" ? "age bands" : `${SPLIT_NOUN[split]}${split === "directory" ? " entries" : "s"}`} · colour is the person's share of that column`}>
          <HeatMatrix rowLabels={result.matrix.people.map((p) => p.label)} columnLabels={matrixSlices.map((s) => s.label)}
            values={result.matrix.values.map((line) => matrixSlices.map((s, col) => s.lines ? line[col] / s.lines : 0))}
            cellSize={28} cellWidth={96} gap={3} maxHeight={480} scaleMax={1} legendFormatter={percent}
            headerTooltip={(axis, index) => axis === "row" ? {
              heading: result.matrix.people[index].label,
              rows: [{ label: "divided lines in scope", value: full(Math.round(result.matrix.people[index].lines)) }],
            } : {
              heading: matrixSlices[index].label,
              rows: [{ label: "surviving lines", value: full(matrixSlices[index].lines) }, { label: "files", value: full(matrixSlices[index].files) }],
            }}
            cellTooltip={(value, r, c) => ({
              heading: `${result.matrix.people[r].label} · ${matrixSlices[c].label}`,
              rows: [
                { label: "divided lines", value: full(Math.round(result.matrix.values[r][c])) },
                { label: "of this column", value: percent(value) },
              ],
            })} />
        </ChartCard>}
      </>}
    </section>
  );
}
