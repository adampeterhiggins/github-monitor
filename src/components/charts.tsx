import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { useMemo, useState, type FocusEvent, type MouseEvent } from "react";
import { useVizPalette } from "../lib/viz/useVizPalette";
import { sequentialStep, seriesColorCycled, OTHER_COLOR, type VizPalette } from "../lib/viz/palette";
import { formatShort, formatDate, weekTickFormatter } from "../lib/agg/weeks";
import { toShares } from "../lib/agg/series";
import { fitAxis } from "../lib/viz/axis";
import { compact, full, useChartHeight } from "./ui";

/**
 * The height a chart was authored at, unless something above it — an expanded
 * view — asked for a different one. See `ChartHeight` in ui.tsx.
 */
function useHeight(authored: number): number {
  return useChartHeight() ?? authored;
}

/* ── Shared chart chrome ────────────────────────────────────────────────────
   Mark specs are fixed: bars <= 24px with a 4px rounded data-end square at the
   baseline, 2px lines, hairline solid gridlines one step off the surface, and
   axis text in muted ink rather than any series color.                        */

const BAR_MAX = 24;
const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0];
const AXIS_FONT = 11;

/**
 * A proportion as a percentage. One decimal below 10% so a small series is not
 * flattened to "0%" while visibly occupying part of the band.
 */
function share(value: number): string {
  const pct = value * 100;
  if (pct > 0 && pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function axisProps(palette: VizPalette) {
  return {
    stroke: palette.baseline,
    tick: { fill: palette.inkMuted, fontSize: AXIS_FONT },
    tickLine: false,
  };
}

function gridProps(palette: VizPalette) {
  return {
    stroke: palette.gridline,
    strokeDasharray: undefined as string | undefined,
    vertical: false,
  };
}


/**
 * Bar geometry for a given number of categories.
 *
 * The 2px surface gap and 4px rounded data-end assume bars are comfortably wide.
 * They are not, on a dense weekly series: 134 weeks in a ~600px card leaves ~4.5px
 * of pitch per bar, and subtracting a 2px gap then rounding by 2px consumes almost
 * the whole mark — what survives is an antialiased sliver that reads as washed-out
 * rather than as the solid colour it is meant to be.
 *
 * So the spacers scale down with the pitch and disappear entirely once bars are
 * hairline width, where touching bars are the honest rendering — the shape of the
 * series is the information, not the separation between individual weeks.
 */
function barGeometry(pointCount: number, fullRadius: [number, number, number, number]) {
  if (pointCount <= 40) return { gap: 2, radius: fullRadius };
  if (pointCount <= 90) return { gap: 1, radius: [1, 1, 0, 0] as [number, number, number, number] };
  return { gap: 0, radius: [0, 0, 0, 0] as [number, number, number, number] };
}

/** Values lead, labels follow; series keyed with a short stroke, not a filled box. */
function TooltipShell({
  heading,
  rows,
  palette,
}: {
  heading: string;
  rows: Array<{ label: string; value: string; color?: string }>;
  palette: VizPalette;
}) {
  return (
    <div
      className="pointer-events-none rounded-md border px-2.5 py-2 shadow-lg"
      style={{
        background: palette.surface,
        borderColor: palette.mode === "dark" ? "rgba(255,255,255,0.14)" : "rgba(11,11,11,0.14)",
      }}
    >
      <div className="mb-1 text-[11px]" style={{ color: palette.inkMuted }}>
        {heading}
      </div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline gap-2 whitespace-nowrap">
          {r.color ? (
            <span
              aria-hidden="true"
              style={{ background: r.color, width: 10, height: 2, borderRadius: 1 }}
              className="mt-1.5 shrink-0"
            />
          ) : null}
          <span
            className="text-[13px] font-semibold tabular"
            style={{ color: palette.ink }}
          >
            {r.value}
          </span>
          <span className="text-[11px]" style={{ color: palette.inkSecondary }}>
            {r.label}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Legend({
  items,
  shape = "line",
}: {
  items: Array<{ label: string; color: string }>;
  shape?: "line" | "rect";
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <span
            aria-hidden="true"
            style={{
              background: it.color,
              width: shape === "line" ? 12 : 9,
              height: shape === "line" ? 2 : 9,
              borderRadius: shape === "line" ? 1 : 2,
            }}
          />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/* ── Weekly commits column chart (the Contributors headline chart) ─────────── */

export interface WeekDatum {
  week: number;
  value: number;
}

export function WeeklyColumns({
  data,
  height = 220,
  metricLabel,
  withBrush = false,
  onBrushChange,
}: {
  data: WeekDatum[];
  height?: number;
  metricLabel: string;
  withBrush?: boolean;
  onBrushChange?: (range: { startIndex: number; endIndex: number }) => void;
}) {
  const palette = useVizPalette();
  const h = useHeight(height);
  // One series: no legend box — the card title already names what is plotted.
  const color = palette.series[0];
  const tick = weekTickFormatter(data.map((d) => d.week));
  const geom = barGeometry(data.length, BAR_RADIUS);

  if (data.length === 0) return <NoData height={h} />;

  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={geom.gap}>
        <CartesianGrid {...gridProps(palette)} />
        <XAxis
          dataKey="week"
          {...axisProps(palette)}
          tickFormatter={tick}
          minTickGap={28}
        />
        <YAxis
          {...axisProps(palette)}
          width={44}
          tickFormatter={(v: number) => compact(v)}
          allowDecimals={false}
        />
        <Tooltip
          cursor={{ fill: palette.mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(11,11,11,0.04)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as WeekDatum;
            return (
              <TooltipShell
                palette={palette}
                heading={`Week of ${formatDate(d.week * 1000)}`}
                rows={[{ label: metricLabel, value: full(d.value), color }]}
              />
            );
          }}
        />
        <Bar dataKey="value" fill={color} maxBarSize={BAR_MAX} radius={geom.radius} minPointSize={1} />
        {withBrush ? (
          <Brush
            dataKey="week"
            height={28}
            travellerWidth={8}
            stroke={palette.baseline}
            fill={palette.mode === "dark" ? "rgba(255,255,255,0.03)" : "rgba(11,11,11,0.02)"}
            tickFormatter={tick}
            onChange={(range) => {
              const r = range as { startIndex?: number; endIndex?: number };
              if (r.startIndex != null && r.endIndex != null) {
                onBrushChange?.({ startIndex: r.startIndex, endIndex: r.endIndex });
              }
            }}
          />
        ) : null}
      </BarChart>
    </ResponsiveContainer>
  );
}



/* ── Timeline area chart ──────────────────────────────────────────────────── */

export type TimelineShape = "area" | "line" | "bar";

/**
 * The curve view: stacked or overlaid areas over time, with a clickable legend.
 *
 * Fill opacity differs by mode on purpose. Stacked bands do not overlap, so the
 * fill *is* the encoding and needs to read as a solid band. Overlaid series do
 * overlap, so a heavy fill would hide whatever sits behind it — there the 2px
 * stroke carries identity and the fill is only a wash.
 *
 * Clicking a legend entry isolates or restores that series. An empty active set
 * means everything is shown, which keeps "no filter" and "all selected"
 * indistinguishable rather than requiring them to be kept in step.
 */
export function TimelineArea({
  data,
  series,
  height = 260,
  shape = "area",
  stackMode = "stacked",
  values = "total",
  valueLabel,
  labelOf,
  activeKeys,
  onToggleKey,
  withBrush = false,
  onBrushChange,
  yMax,
  yMin = 0,
  animate = true,
  yFit = false,
}: {
  data: Array<Record<string, number>>;
  series: StackSeriesSpec[];
  height?: number;
  shape?: TimelineShape;
  /** Off for dense histories: animating thousands of marks delays every control change. */
  animate?: boolean;
  /**
   * Stretch the y axis to the visible data instead of 0–100% (shares) or zero
   * upwards (totals). Stacks and shares keep a zero baseline; overlaid totals need not.
   */
  yFit?: boolean;
  stackMode?: "stacked" | "overlaid";
  /**
   * What the y axis measures. `share` reads the total at each point as 100% and
   * plots each series' part of it, which answers "who made up this week" rather
   * than "how much was there".
   *
   * Independent of stacking, because the two answer different questions. Stacked
   * shares fill the band and show composition; overlaid shares put each series on
   * the same 0–100% axis, which is how you see whose share is largest at a given
   * point without adding bands up by eye.
   */
  values?: "total" | "share";
  valueLabel: string;
  /** Formats the x value for the tooltip heading. */
  labelOf: (week: number) => string;
  /** Empty means every series is shown. */
  activeKeys?: Set<string>;
  onToggleKey?: (key: string) => void;
  withBrush?: boolean;
  onBrushChange?: (range: { startIndex: number; endIndex: number }) => void;
  /**
   * Shared upper bound across a set of small multiples. Without it each chart
   * self-scales and two very different contributors draw the same picture.
   */
  yMax?: number;
  /** Shared lower bound, for a metric that goes below zero. Ignored without yMax. */
  yMin?: number;
}) {
  const palette = useVizPalette();
  const h = useHeight(height);
  const tick = weekTickFormatter(data.map((d) => d.week));
  const geom = barGeometry(data.length, BAR_RADIUS);
  const stacked = stackMode === "stacked";
  const normalised = values === "share";
  /* Shares are computed rather than left to `stackOffset="expand"` (see toShares),
     so a stack only needs to know which way each one points: "sign" grows the
     positives up from zero and the negatives down. Overlaid shares are not stacked
     at all, and lines never stack — recharts dropped that, and each line being its
     own share reads better than stacked boundaries anyway. */
  const stackOffset = normalised && stacked && shape !== "line" ? "sign" : undefined;

  const colored = series.map((s) => ({
    ...s,
    /* "Other" is muted ink; a real series takes its slot, and past the eighth the
       hues repeat — see seriesColorCycled for why that is the lesser evil. */
    color: s.slot == null ? palette.inkMuted : seriesColorCycled(palette, s.slot),
  }));

  /**
   * Selecting from the legend dims the rest rather than removing it.
   *
   * Removing a band re-scales the whole chart, so isolating one series changes
   * every other number on screen and you lose the thing you were comparing it
   * against. Dimming keeps the stack, the axis and the proportions exactly where
   * they were and only changes what your eye is drawn to. An empty selection means
   * everything is at full strength, which keeps "nothing selected" and "all
   * selected" from being two states that look different.
   */
  /* A selection that nothing on screen matches is no selection at all. Without
     this the chart dims every band and the legend offers nothing to click, because
     the series that would clear the filter is not there to be clicked. */
  const filtered = activeKeys != null && colored.some((s) => activeKeys.has(s.key));
  const isActive = (key: string) => !filtered || activeKeys!.has(key);
  const dim = (key: string) => (isActive(key) ? 1 : 0.18);

  // A fresh array every render makes the brush treat the data as new and reset,
  // which re-renders, which builds another array. Expanded charts show that as a shake.
  const seriesKey = series.map((s) => s.key).join("\0");
  const plotted = useMemo(
    () => (normalised ? toShares(data, seriesKey ? seriesKey.split("\0") : []) : data),
    [normalised, data, seriesKey],
  );

  if (data.length === 0 || series.length === 0) return <NoData height={h} />;
  /* Room under the baseline only when something goes there, so a share chart of
     commits still fills the plot rather than giving half of it to an empty half. */
  const shareFloor =
    normalised && plotted.some((row) => colored.some((s) => (row[s.key] ?? 0) < 0)) ? -1 : 0;
  /* The tooltip always reports the real numbers, so it reads off the untouched
     rows rather than whatever was plotted. */
  const rawByWeek =
    plotted === data ? null : new Map(data.map((row) => [row.week, row] as const));
  const fit = yFit ? fitAxis(plotted, colored.filter((s) => isActive(s.key)).map((s) => s.key), stacked && shape !== "line", normalised) : null;

  const axes = (
    <>
      <CartesianGrid {...gridProps(palette)} />
      <XAxis dataKey="week" {...axisProps(palette)} tickFormatter={tick} minTickGap={28} />
      <YAxis
        {...axisProps(palette)}
        width={48}
        tickFormatter={normalised ? share : compact}
        // Quarter ticks are decimals; the default integer-only axis would leave a
        // share chart with nothing between 0% and 100%.
        allowDecimals={normalised || fit != null}
        ticks={
          fit
            ? fit.ticks
            : normalised
              ? shareFloor < 0
                ? [-1, -0.5, 0, 0.5, 1]
                : [0, 0.25, 0.5, 0.75, 1]
              : undefined
        }
        domain={fit ? fit.domain : normalised ? [shareFloor, 1] : yMax != null ? [yMin, yMax] : undefined}
      />
      <Tooltip
        // A crosshair on continuous forms so the reader aims at a date rather than
        // at a 2px line; bars keep the per-mark highlight.
        cursor={
          shape === "bar"
            ? { fill: palette.mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(11,11,11,0.04)" }
            : { stroke: palette.baseline, strokeWidth: 1 }
        }
        content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const plottedRow = payload[0].payload as Record<string, number>;
          const row = rawByWeek?.get(Number(plottedRow.week)) ?? plottedRow;
          const rows = colored
            .filter((s) => isActive(s.key))
            .map((s) => ({ label: s.label, raw: Number(row[s.key] ?? 0), color: s.color }))
            .filter((r) => r.raw !== 0)
            .sort((a, b) => Math.abs(b.raw) - Math.abs(a.raw));
          const total = rows.reduce((a, r) => a + r.raw, 0);
          const churn = rows.reduce((a, r) => a + Math.abs(r.raw), 0);
          const capped = rows.slice(0, 10);
          return (
            <TooltipShell
              palette={palette}
              heading={`${labelOf(Number(row.week))}${
                rows.length > 1 ? ` · ${full(total)} ${valueLabel}` : ""
              }`}
              rows={[
                ...capped.map((r) => ({
                  label: normalised ? `${r.label} · ${full(r.raw)}` : r.label,
                  value: normalised ? share(churn === 0 ? 0 : r.raw / churn) : full(r.raw),
                  color: r.color,
                })),
                ...(rows.length > capped.length
                  ? [{ label: `and ${rows.length - capped.length} more`, value: "" }]
                  : []),
              ]}
            />
          );
        }}
      />
    </>
  );

  const brush = withBrush ? (
    <Brush
      dataKey="week"
      height={28}
      travellerWidth={8}
      stroke={palette.baseline}
      fill={palette.mode === "dark" ? "rgba(255,255,255,0.03)" : "rgba(11,11,11,0.02)"}
      tickFormatter={tick}
      onChange={(range) => {
        const r = range as { startIndex?: number; endIndex?: number };
        if (r.startIndex != null && r.endIndex != null) {
          onBrushChange?.({ startIndex: r.startIndex, endIndex: r.endIndex });
        }
      }}
    />
  ) : null;

  return (
    <div>
      <ResponsiveContainer width="100%" height={h}>
        {shape === "bar" ? (
          <BarChart
            data={plotted}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            barCategoryGap={geom.gap}
            stackOffset={stackOffset}
          >
            {axes}
            {colored.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId={stacked ? "stack" : undefined}
                fill={s.color}
                fillOpacity={dim(s.key)}
                maxBarSize={BAR_MAX}
                radius={!stacked || i === colored.length - 1 ? geom.radius : [0, 0, 0, 0]}
                isAnimationActive={animate}
              />
            ))}
            {brush}
          </BarChart>
        ) : shape === "line" ? (
          <LineChart
            data={plotted}
            margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            stackOffset={stackOffset}
          >
            {axes}
            {colored.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeOpacity={dim(s.key)}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: palette.surface }}
                isAnimationActive={animate}
              />
            ))}
            {brush}
          </LineChart>
        ) : (
          <AreaChart
            data={plotted}
            margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            stackOffset={stackOffset}
          >
            {axes}
            {colored.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stackId={stacked ? "stack" : undefined}
                stroke={s.color}
                strokeOpacity={dim(s.key)}
                strokeWidth={2}
                fill={s.color}
                fillOpacity={(stacked ? 0.75 : 0.12) * dim(s.key)}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: palette.surface }}
                isAnimationActive={animate}
              />
            ))}
            {brush}
          </AreaChart>
        )}
      </ResponsiveContainer>

      {colored.length >= 2 ? (
        <div className="mt-2">
          <ClickableLegend
            items={colored.map((s) => ({ key: s.key, label: s.label, color: s.color }))}
            isActive={isActive}
            onToggle={onToggleKey}
            filtered={filtered}
            shape={shape === "line" ? "line" : "rect"}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Legend whose entries toggle their series.
 *
 * Inactive entries drop to 35% rather than losing their swatch, so the set of
 * series stays legible while filtered — hiding them would make it impossible to
 * find what you switched off.
 */
export function ClickableLegend({
  items,
  isActive,
  onToggle,
  filtered = false,
  shape = "rect",
}: {
  items: Array<{ key: string; label: string; color: string }>;
  isActive: (key: string) => boolean;
  onToggle?: (key: string) => void;
  /** Whether anything is selected, which decides what a click will do. */
  filtered?: boolean;
  shape?: "line" | "rect";
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((it) => {
        const active = isActive(it.key);
        return (
          <li key={it.key}>
            <button
              type="button"
              onClick={() => onToggle?.(it.key)}
              disabled={!onToggle}
              // Nothing selected is not the same as everything selected, even
              // though both draw at full strength.
              aria-pressed={filtered && active}
              title={
                !onToggle
                  ? it.label
                  : !filtered
                    ? `Show only ${it.label}`
                    : active
                      ? `Remove ${it.label} from the selection`
                      : `Add ${it.label} to the selection`
              }
              className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-ink-secondary transition-opacity hover:bg-wash disabled:cursor-default"
              style={{ opacity: active ? 1 : 0.35 }}
            >
              <span
                aria-hidden="true"
                style={{
                  background: it.color,
                  width: shape === "line" ? 12 : 9,
                  height: shape === "line" ? 2 : 9,
                  borderRadius: shape === "line" ? 1 : 2,
                }}
              />
              {it.label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export interface StackSeriesSpec {
  key: string;
  label: string;
  /** 0..7 for a categorical slot; null renders as the muted "Other" band. */
  slot: number | null;
}

/* ── Sparkline (contributor cards) ────────────────────────────────────────── */

export function Sparkline({
  data,
  height = 56,
  colorIndex = 0,
  metricLabel,
  yMax,
  yMin = 0,
}: {
  data: WeekDatum[];
  height?: number;
  colorIndex?: number;
  metricLabel: string;
  /**
   * Shared upper bound across a set of small multiples. Without it each card
   * self-scales and two very different contributors draw identical-looking charts.
   */
  yMax?: number;
  /** Shared lower bound, for a metric that goes below zero. Ignored without yMax. */
  yMin?: number;
}) {
  const palette = useVizPalette();
  const h = useHeight(height);
  // Small multiples all carry the same single series, so the all-pairs series cap
  // does not bite here — every card is slot 1.
  const color = palette.series[colorIndex] ?? palette.series[0];
  const tick = weekTickFormatter(data.map((d) => d.week));
  const geom = barGeometry(data.length, [2, 2, 0, 0]);

  if (data.length === 0) return <NoData height={h} compactMessage />;

  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart
        data={data}
        margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
        barCategoryGap={geom.gap}
      >
        <CartesianGrid {...gridProps(palette)} />
        <XAxis
          dataKey="week"
          {...axisProps(palette)}
          tick={{ fill: palette.inkMuted, fontSize: 10 }}
          tickFormatter={tick}
          minTickGap={34}
          axisLine={false}
        />
        <YAxis
          {...axisProps(palette)}
          orientation="right"
          width={30}
          axisLine={false}
          tick={{ fill: palette.inkMuted, fontSize: 9 }}
          tickCount={3}
          allowDecimals={false}
          domain={yMax != null ? [yMin, yMax] : undefined}
          tickFormatter={compact}
        />
        <Tooltip
          cursor={{ fill: palette.mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(11,11,11,0.04)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as WeekDatum;
            return (
              <TooltipShell
                palette={palette}
                heading={`Week of ${formatDate(d.week * 1000)}`}
                rows={[{ label: metricLabel, value: full(d.value), color }]}
              />
            );
          }}
        />
        <Bar
          dataKey="value"
          fill={color}
          maxBarSize={14}
          radius={geom.radius}
          /* A week with activity must paint at least a pixel, or low-but-nonzero
             weeks vanish and read the same as silence. */
          minPointSize={1}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── Code frequency: additions above the baseline, deletions below ─────────── */

export function DivergingWeekly({
  data,
  height = 260,
}: {
  data: Array<{ week: number; additions: number; deletions: number }>;
  height?: number;
}) {
  const palette = useVizPalette();
  const h = useHeight(height);
  // Genuine polarity around zero, so this takes the diverging pair rather than
  // two categorical slots.
  const pos = palette.diverging.positive;
  const neg = palette.diverging.negative;

  const shaped = useMemo(
    () => data.map((d) => ({ week: d.week, additions: d.additions, deletions: -d.deletions })),
    [data],
  );
  const tick = weekTickFormatter(data.map((d) => d.week));
  const geom = barGeometry(data.length, BAR_RADIUS);

  if (data.length === 0) return <NoData height={h} />;

  return (
    <div>
      <ResponsiveContainer width="100%" height={h}>
        <BarChart data={shaped} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={geom.gap} stackOffset="sign">
          <CartesianGrid {...gridProps(palette)} />
          <XAxis
            dataKey="week"
            {...axisProps(palette)}
            tickFormatter={tick}
            minTickGap={28}
          />
          <YAxis
            {...axisProps(palette)}
            width={52}
            tickFormatter={(v: number) => compact(Math.abs(v))}
          />
          <ReferenceLine y={0} stroke={palette.baseline} />
          <Tooltip
            cursor={{ fill: palette.mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(11,11,11,0.04)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as { week: number; additions: number; deletions: number };
              return (
                <TooltipShell
                  palette={palette}
                  heading={`Week of ${formatDate(d.week * 1000)}`}
                  rows={[
                    { label: "additions", value: `+${full(d.additions)}`, color: pos },
                    { label: "deletions", value: `−${full(Math.abs(d.deletions))}`, color: neg },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="additions" fill={pos} stackId="cf" maxBarSize={BAR_MAX} radius={geom.radius} />
          <Bar
            dataKey="deletions"
            fill={neg}
            stackId="cf"
            maxBarSize={BAR_MAX}
            radius={geom.radius[0] ? [0, 0, geom.radius[0], geom.radius[1]] : [0, 0, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2">
        <Legend shape="rect" items={[{ label: "Additions", color: pos }, { label: "Deletions", color: neg }]} />
      </div>
    </div>
  );
}

/* ── Multi-series daily lines (Pulse, Actions) ─────────────────────────────── */

export interface SeriesSpec {
  key: string;
  label: string;
  /** Categorical slot index, assigned in fixed order and never cycled. */
  slot: number;
}

export function DailyLines({
  data,
  series,
  height = 240,
  valueFormatter = full,
}: {
  data: Array<Record<string, number | string>>;
  series: SeriesSpec[];
  height?: number;
  valueFormatter?: (n: number) => string;
}) {
  const palette = useVizPalette();
  const h = useHeight(height);
  const colored = series.map((s) => ({ ...s, color: palette.series[s.slot] ?? palette.inkMuted }));

  if (data.length === 0) return <NoData height={h} />;

  return (
    <div>
      <ResponsiveContainer width="100%" height={h}>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid {...gridProps(palette)} />
          <XAxis
            dataKey="day"
            {...axisProps(palette)}
            tickFormatter={(d: string) => formatShort(new Date(`${d}T00:00:00Z`))}
            minTickGap={28}
          />
          <YAxis {...axisProps(palette)} width={44} tickFormatter={compact} allowDecimals={false} />
          {/* Crosshair finds the X so the reader aims at a date, not a 2px line. */}
          <Tooltip
            cursor={{ stroke: palette.baseline, strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              return (
                <TooltipShell
                  palette={palette}
                  heading={formatDate(new Date(`${String(label)}T00:00:00Z`))}
                  rows={colored.map((s) => ({
                    label: s.label,
                    value: valueFormatter(
                      Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0),
                    ),
                    color: s.color,
                  }))}
                />
              );
            }}
          />
          {colored.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: palette.surface }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {colored.length >= 2 ? (
        <div className="mt-2">
          <Legend items={colored.map((s) => ({ label: s.label, color: s.color }))} />
        </div>
      ) : null}
    </div>
  );
}

/* ── Stacked daily area (traffic) ──────────────────────────────────────────── */

export function DailyArea({
  data,
  series,
  height = 240,
}: {
  data: Array<Record<string, number | string>>;
  series: SeriesSpec[];
  height?: number;
}) {
  const palette = useVizPalette();
  const h = useHeight(height);
  const colored = series.map((s) => ({ ...s, color: palette.series[s.slot] ?? palette.inkMuted }));

  if (data.length === 0) return <NoData height={h} />;

  return (
    <div>
      <ResponsiveContainer width="100%" height={h}>
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid {...gridProps(palette)} />
          <XAxis
            dataKey="day"
            {...axisProps(palette)}
            tickFormatter={(d: string) => formatShort(new Date(`${d}T00:00:00Z`))}
            minTickGap={28}
          />
          <YAxis {...axisProps(palette)} width={44} tickFormatter={compact} allowDecimals={false} />
          <Tooltip
            cursor={{ stroke: palette.baseline, strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              return (
                <TooltipShell
                  palette={palette}
                  heading={formatDate(new Date(`${String(label)}T00:00:00Z`))}
                  rows={colored.map((s) => ({
                    label: s.label,
                    value: full(Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0)),
                    color: s.color,
                  }))}
                />
              );
            }}
          />
          {colored.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={2}
              /* Area fill is a wash, never a saturated block. */
              fill={s.color}
              fillOpacity={0.1}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: palette.surface }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      {colored.length >= 2 ? (
        <div className="mt-2">
          <Legend items={colored.map((s) => ({ label: s.label, color: s.color }))} />
        </div>
      ) : null}
    </div>
  );
}

/* ── Horizontal ranked bars (repo / contributor breakdowns) ────────────────── */

export function RankedBars({
  data,
  height,
  valueLabel,
  valueFormatter = full,
  domain,
  showAxis = false,
  labelWidth = 190,
  truncateLabels = false,
}: {
  data: Array<{ name: string; value: number }>;
  height?: number;
  valueLabel: string;
  valueFormatter?: (value: number) => string;
  domain?: [number, number];
  showAxis?: boolean;
  labelWidth?: number;
  truncateLabels?: boolean;
}) {
  const palette = useVizPalette();
  // Nominal categories: one hue for every bar. Coloring them by value would spend
  // the identity channel re-encoding what bar length already shows.
  const color = palette.series[0];
  const h = useHeight(height ?? Math.max(120, data.length * 26 + 24));

  if (data.length === 0) return <NoData height={h} />;

  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 56, bottom: 4, left: 8 }}
        barCategoryGap={2}
      >
        <CartesianGrid stroke={palette.gridline} horizontal={false} />
        <XAxis type="number" {...axisProps(palette)} domain={domain} tickFormatter={domain ? valueFormatter : compact} hide={!showAxis} />
        <YAxis
          type="category"
          dataKey="name"
          {...axisProps(palette)}
          width={labelWidth}
          tickFormatter={(name: string) => truncateLabels && name.length > 24 ? `${name.slice(0, 23)}…` : name}
          axisLine={false}
          interval={0}
        />
        <Tooltip
          cursor={{ fill: palette.mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(11,11,11,0.04)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as { name: string; value: number };
            return (
              <TooltipShell
                palette={palette}
                heading={d.name}
                rows={[{ label: valueLabel, value: valueFormatter(d.value), color }]}
              />
            );
          }}
        />
        <Bar
          dataKey="value"
          fill={color}
          maxBarSize={BAR_MAX}
          radius={[0, 4, 4, 0]}
          label={{
            position: "right",
            fontSize: 11,
            /* Value at the tip, in ink — never in the series color. */
            fill: palette.inkSecondary,
            formatter: (v: unknown) => domain ? valueFormatter(Number(v ?? 0)) : compact(Number(v ?? 0)),
          }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── Punch card heatmap ────────────────────────────────────────────────────── */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function PunchCard({
  cells,
  timeZoneNote,
}: {
  cells: Array<{ dow: number; hour: number; commits: number }>;
  timeZoneNote?: string;
}) {
  const palette = useVizPalette();
  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    let max = 0;
    for (const c of cells) {
      if (c.dow >= 0 && c.dow < 7 && c.hour >= 0 && c.hour < 24) {
        g[c.dow][c.hour] = c.commits;
        if (c.commits > max) max = c.commits;
      }
    }
    return { g, max };
  }, [cells]);

  if (grid.max === 0) return <NoData height={200} />;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="border-separate" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th />
              {Array.from({ length: 24 }, (_, h) => (
                <th
                  key={h}
                  className="text-[9px] font-normal"
                  style={{ color: palette.inkMuted, minWidth: 18 }}
                >
                  {h % 3 === 0 ? h : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAY_LABELS.map((day, dow) => (
              <tr key={day}>
                <th
                  className="pr-1.5 text-right text-[10px] font-normal"
                  style={{ color: palette.inkMuted }}
                >
                  {day}
                </th>
                {Array.from({ length: 24 }, (_, hour) => {
                  const v = grid.g[dow][hour];
                  // Sequential magnitude; a true zero stays off the ramp so "no
                  // activity" never reads as "a little activity".
                  const fill = sequentialStep(palette, v / grid.max, true);
                  const label = `${day} ${String(hour).padStart(2, "0")}:00 — ${full(v)} commit${v === 1 ? "" : "s"}`;
                  return (
                    <td key={hour} style={{ padding: 0 }}>
                      <div
                        tabIndex={0}
                        role="img"
                        aria-label={label}
                        title={label}
                        className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                        style={{
                          width: 18,
                          height: 18,
                          background: fill ?? "transparent",
                          border: fill ? "none" : `1px solid ${palette.gridline}`,
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between gap-4">
        <span className="text-[11px] text-ink-secondary">
          {timeZoneNote ?? "Hours are UTC, as reported by GitHub"}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-ink-muted">0</span>
          {[0.15, 0.35, 0.55, 0.75, 1].map((t) => (
            <span
              key={t}
              aria-hidden="true"
              className="rounded-sm"
              style={{ width: 14, height: 14, background: sequentialStep(palette, t, false)! }}
            />
          ))}
          <span className="text-[10px] text-ink-muted">{full(grid.max)}</span>
        </div>
      </div>
    </div>
  );
}

/* ── Meter (community health) ──────────────────────────────────────────────── */

export function Meter({ value, max = 100 }: { value: number; max?: number }) {
  const palette = useVizPalette();
  const pct = Math.max(0, Math.min(1, value / max));
  // Fill carries severity; the track is a lighter step of the same ramp so the
  // state reads across the whole bar.
  const fill =
    pct >= 0.8 ? palette.status.good : pct >= 0.5 ? palette.status.warning : palette.status.critical;
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: palette.mode === "dark" ? "#2c2c2a" : "#e1e0d9" }}
      >
        <div style={{ width: `${pct * 100}%`, height: "100%", background: fill, borderRadius: 999 }} />
      </div>
      <span className="w-8 shrink-0 text-right text-[11px] tabular text-ink-secondary">
        {Math.round(pct * 100)}%
      </span>
    </div>
  );
}

/* ── Grouped columns (Pulse totals, Actions outcomes) ─────────────────────── */

export function GroupedColumns({
  data,
  series,
  height = 240,
  xKey = "name",
}: {
  data: Array<Record<string, number | string>>;
  series: SeriesSpec[];
  height?: number;
  xKey?: string;
}) {
  const palette = useVizPalette();
  const h = useHeight(height);
  const colored = series.map((s) => ({ ...s, color: palette.series[s.slot] ?? palette.inkMuted }));

  if (data.length === 0) return <NoData height={h} />;

  return (
    <div>
      <ResponsiveContainer width="100%" height={h}>
        {/* barGap 2 is the surface gap that separates touching bars. */}
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
          <CartesianGrid {...gridProps(palette)} />
          <XAxis dataKey={xKey} {...axisProps(palette)} interval={0} />
          <YAxis {...axisProps(palette)} width={44} tickFormatter={compact} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: palette.mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(11,11,11,0.04)" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              return (
                <TooltipShell
                  palette={palette}
                  heading={String(label)}
                  rows={colored.map((s) => ({
                    label: s.label,
                    value: full(Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0)),
                    color: s.color,
                  }))}
                />
              );
            }}
          />
          {colored.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill={s.color} maxBarSize={BAR_MAX} radius={BAR_RADIUS} />
          ))}
        </BarChart>
      </ResponsiveContainer>
      {colored.length >= 2 ? (
        <div className="mt-2">
          <Legend shape="rect" items={colored.map((s) => ({ label: s.label, color: s.color }))} />
        </div>
      ) : null}
    </div>
  );
}

/* ── Status breakdown bar (Actions success / failure) ─────────────────────── */

export function StatusBar({
  segments,
  total,
}: {
  segments: Array<{ label: string; value: number; tone: "good" | "warning" | "serious" | "critical" | "muted" }>;
  total: number;
}) {
  const palette = useVizPalette();
  if (total === 0) return <NoData height={40} compactMessage />;

  const colorFor = (tone: string) =>
    tone === "muted" ? palette.inkMuted : palette.status[tone as keyof typeof palette.status];

  return (
    <div>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <div
              key={s.label}
              style={{ width: `${(s.value / total) * 100}%`, background: colorFor(s.tone) }}
              title={`${s.label}: ${full(s.value)}`}
            />
          ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
            {/* Status wears an icon plus a label, never color alone. */}
            <span aria-hidden="true" style={{ color: colorFor(s.tone) }}>
              {s.tone === "good" ? "●" : s.tone === "critical" ? "▲" : s.tone === "muted" ? "○" : "◆"}
            </span>
            <span className="tabular text-ink">{full(s.value)}</span> {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Heat matrix (ownership, community coverage) ──────────────────────────── */

export interface HeatTooltipContent {
  heading: string;
  rows: Array<{ label: string; value: string }>;
}

/**
 * A labelled grid of sequential or binary cells.
 *
 * Same encoding rules as the punch card: a true zero stays off the ramp so
 * "none" never reads as "a little", and every cell has a text label. The first
 * column and the header stick so a wide org still has somewhere to look.
 *
 * Native `title` is not enough here — repository names truncate, and a cell is
 * more than one number — so hover opens the same tooltip shell the charts use.
 */
export function HeatMatrix({
  rowLabels,
  columnLabels,
  values,
  format,
  mode = "sequential",
  maxHeight = 480,
  headerTooltip,
  cellTooltip,
  cellSize = 18,
  cellWidth = cellSize,
  scaleMax,
  legendFormatter = full,
  gap = 2,
  borders = true,
}: {
  rowLabels: string[];
  columnLabels: string[];
  /** Row-major, same shape as the label arrays. */
  values: number[][];
  format?: (value: number, row: number, col: number) => string;
  mode?: "sequential" | "binary";
  maxHeight?: number;
  /** Richer hover for an axis label. Falls back to the visible label. */
  headerTooltip?: (axis: "row" | "column", index: number) => HeatTooltipContent;
  /** Richer hover for a cell. Falls back to `format` plus the two labels. */
  cellTooltip?: (value: number, row: number, col: number) => HeatTooltipContent;
  /** Square edge in CSS pixels. Headers stay the same width so gap can reach zero. */
  cellSize?: number;
  /** Wider cells allow repository labels to remain readable in rectangular matrices. */
  cellWidth?: number;
  /** Fixed domain for comparable proportions; defaults to the largest value. */
  scaleMax?: number;
  legendFormatter?: (value: number) => string;
  /** White space between squares in CSS pixels. 0 tiles them flush. */
  gap?: number;
  /** Outline on empty squares. Filled cells never stroke. */
  borders?: boolean;
}) {
  const palette = useVizPalette();
  const [tip, setTip] = useState<{
    x: number;
    y: number;
    content: HeatTooltipContent;
    flip: boolean;
  } | null>(null);

  const max = useMemo(() => {
    if (scaleMax != null) return scaleMax;
    let m = 0;
    for (const row of values) for (const v of row) if (v > m) m = v;
    return m;
  }, [values, scaleMax]);

  const offered = useChartHeight();

  if (rowLabels.length === 0 || columnLabels.length === 0) {
    return <NoData height={160} />;
  }

  const fillOf = (v: number) => {
    if (mode === "binary") {
      return v > 0 ? palette.status.good : null;
    }
    return sequentialStep(palette, max === 0 ? 0 : v / max, true);
  };

  const show = (
    event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>,
    content: HeatTooltipContent,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 240;
    const x = Math.min(rect.left + rect.width / 2, window.innerWidth - width / 2 - 8);
    const below = rect.bottom + 8;
    const flip = below + 88 > window.innerHeight;
    const y = flip ? rect.top - 8 : below;
    setTip({
      x: Math.max(width / 2 + 8, x),
      y,
      content,
      flip,
    });
  };

  const hide = () => setTip(null);
  const radius = gap <= 0 ? 0 : Math.min(gap, cellSize >= 28 ? 3 : 2);

  const headerContent = (axis: "row" | "column", index: number): HeatTooltipContent => {
    if (headerTooltip) return headerTooltip(axis, index);
    return { heading: axis === "row" ? rowLabels[index] : columnLabels[index], rows: [] };
  };

  const cellContent = (r: number, c: number, v: number): HeatTooltipContent => {
    if (cellTooltip) return cellTooltip(v, r, c);
    const text = format ? format(v, r, c) : String(v);
    return { heading: `${rowLabels[r]} · ${columnLabels[c]}`, rows: [{ label: "value", value: text }] };
  };

  return (
    <div
      className={offered != null ? "flex flex-col" : undefined}
      style={offered != null ? { height: offered } : undefined}
    >
      <div
        className={offered != null ? "min-h-0 flex-1 overflow-auto" : "overflow-auto"}
        style={offered == null ? { maxHeight } : undefined}
        onMouseLeave={hide}
      >
        <table className="border-separate" style={{ borderSpacing: gap }}>
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 bg-surface" />
              {columnLabels.map((label, c) => (
                <th
                  key={c}
                  className="sticky top-0 z-10 cursor-default bg-surface p-0 text-center text-[9px] font-normal"
                  style={{ color: palette.inkMuted, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                  onMouseEnter={(e) => show(e, headerContent("column", c))}
                  onFocus={(e) => show(e, headerContent("column", c))}
                  onBlur={hide}
                  tabIndex={0}
                >
                  <span className="block truncate" style={{ width: cellWidth }}>
                    {label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowLabels.map((rowLabel, r) => (
              <tr key={r}>
                <th
                  className="sticky left-0 z-10 cursor-default truncate bg-surface pr-1.5 text-right text-[10px] font-normal"
                  style={{ color: palette.inkMuted, maxWidth: 140 }}
                  onMouseEnter={(e) => show(e, headerContent("row", r))}
                  onFocus={(e) => show(e, headerContent("row", r))}
                  onBlur={hide}
                  tabIndex={0}
                >
                  {rowLabel}
                </th>
                {columnLabels.map((_colLabel, c) => {
                  const v = values[r]?.[c] ?? 0;
                  const fill = fillOf(v);
                  const content = cellContent(r, c, v);
                  const aria = `${content.heading} — ${content.rows.map((row) => `${row.value} ${row.label}`).join(", ")}`;
                  return (
                    <td key={c} style={{ padding: 0 }}>
                      <div
                        tabIndex={0}
                        role="img"
                        aria-label={aria}
                        onMouseEnter={(e) => show(e, content)}
                        onFocus={(e) => show(e, content)}
                        onBlur={hide}
                        className="focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                        style={{
                          width: cellWidth,
                          height: cellSize,
                          borderRadius: radius,
                          background: fill ?? "transparent",
                          border: fill || !borders ? "none" : `1px solid ${palette.gridline}`,
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mode === "sequential" ? (
        <div className="mt-3 flex items-center justify-end gap-1.5">
          <span className="text-[10px] text-ink-muted">0</span>
          {[0.15, 0.35, 0.55, 0.75, 1].map((t) => (
            <span
              key={t}
              aria-hidden="true"
              className="rounded-sm"
              style={{ width: 14, height: 14, background: sequentialStep(palette, t, false)! }}
            />
          ))}
          <span className="text-[10px] text-ink-muted">{legendFormatter(max)}</span>
        </div>
      ) : null}
      {tip ? (
        <div
          className="pointer-events-none fixed z-50"
          style={{
            left: tip.x,
            top: tip.y,
            transform: tip.flip ? "translate(-50%, -100%)" : "translate(-50%, 0)",
          }}
        >
          <TooltipShell palette={palette} heading={tip.content.heading} rows={tip.content.rows} />
        </div>
      ) : null}
    </div>
  );
}

/* ── Waffle (concentration as 100 squares) ────────────────────────────────── */

export function Waffle({
  cells,
}: {
  cells: Array<{ label: string; count: number; color: string }>;
}) {
  const palette = useVizPalette();
  const squares: Array<{ label: string; color: string }> = [];
  for (const c of cells) {
    for (let i = 0; i < c.count; i++) squares.push({ label: c.label, color: c.color });
  }
  if (squares.length === 0) return <NoData height={120} />;

  return (
    <div>
      <div
        className="grid gap-0.5"
        style={{ gridTemplateColumns: "repeat(20, minmax(0, 1fr))" }}
        role="img"
        aria-label={cells.map((c) => `${c.label}: ${c.count}`).join(", ")}
      >
        {squares.map((s, i) => (
          <div
            key={i}
            title={s.label}
            className="aspect-square rounded-[2px]"
            style={{ background: s.color }}
          />
        ))}
      </div>
      <div className="mt-2">
        <Legend
          shape="rect"
          items={cells
            .filter((c) => c.count > 0)
            .map((c) => ({ label: `${c.label} (${c.count})`, color: c.color }))}
        />
      </div>
      <p className="mt-1 text-[10px] text-ink-muted" style={{ color: palette.inkMuted }}>
        One square is one percent of commits in the selection.
      </p>
    </div>
  );
}

export function otherColor(palette: VizPalette): string {
  return OTHER_COLOR[palette.mode];
}

/* ── Stacked daily area (referrer share over time) ────────────────────────── */

export function StackedDailyArea({
  data,
  series,
  height = 240,
  values = "share",
  valueLabel,
}: {
  data: Array<Record<string, number | string>>;
  series: StackSeriesSpec[];
  height?: number;
  values?: "total" | "share";
  valueLabel: string;
}) {
  const palette = useVizPalette();
  const h = useHeight(height);
  const normalised = values === "share";
  const colored = series.map((s) => ({
    ...s,
    color: s.slot == null ? palette.inkMuted : seriesColorCycled(palette, s.slot),
  }));

  if (data.length === 0 || series.length === 0) return <NoData height={h} />;

  const keys = colored.map((s) => s.key);
  const numeric = data.map((row) => {
    const out: Record<string, number | string> = { ...row };
    for (const k of keys) out[k] = Number(row[k] ?? 0);
    return out;
  });
  const plotted = normalised
    ? toShares(
        numeric.map((row) => {
          const wide: Record<string, number> = { week: 0 };
          for (const k of keys) wide[k] = Number(row[k] ?? 0);
          return wide;
        }),
        keys,
      ).map((wide, i) => {
        const out: Record<string, number | string> = { day: numeric[i].day };
        for (const k of keys) out[k] = wide[k] ?? 0;
        return out;
      })
    : numeric;

  return (
    <div>
      <ResponsiveContainer width="100%" height={h}>
        <AreaChart data={plotted} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid {...gridProps(palette)} />
          <XAxis
            dataKey="day"
            {...axisProps(palette)}
            tickFormatter={(d: string) => formatShort(new Date(`${d}T00:00:00Z`))}
            minTickGap={28}
          />
          <YAxis
            {...axisProps(palette)}
            width={48}
            tickFormatter={normalised ? share : compact}
            allowDecimals={normalised}
            ticks={normalised ? [0, 0.25, 0.5, 0.75, 1] : undefined}
            domain={normalised ? [0, 1] : undefined}
          />
          <Tooltip
            cursor={{ stroke: palette.baseline, strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const raw = numeric.find((r) => r.day === label);
              const rows = colored
                .map((s) => ({
                  label: s.label,
                  raw: Number(raw?.[s.key] ?? 0),
                  color: s.color,
                }))
                .filter((r) => r.raw !== 0)
                .sort((a, b) => b.raw - a.raw);
              const total = rows.reduce((a, r) => a + r.raw, 0);
              return (
                <TooltipShell
                  palette={palette}
                  heading={formatDate(new Date(`${String(label)}T00:00:00Z`))}
                  rows={rows.map((r) => ({
                    label: r.label,
                    value: normalised
                      ? `${share(total === 0 ? 0 : r.raw / total)} · ${full(r.raw)}`
                      : full(r.raw),
                    color: r.color,
                  }))}
                />
              );
            }}
          />
          {colored.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stackId="referrers"
              stroke={s.color}
              strokeWidth={1.5}
              fill={s.color}
              fillOpacity={0.85}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 2, stroke: palette.surface }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <div className="mt-2">
        <Legend items={colored.map((s) => ({ label: s.label, color: s.color }))} />
      </div>
      <span className="sr-only">{valueLabel}</span>
    </div>
  );
}

/* ── Scatter (PR size vs time-to-merge) ───────────────────────────────────── */

export interface ScatterPoint {
  size: number;
  hours: number;
  discussion: number;
  label: string;
  detail: string;
}

export function MergeScatter({
  points,
  height = 280,
}: {
  points: ScatterPoint[];
  height?: number;
}) {
  const palette = useVizPalette();
  const h = useHeight(height);
  const color = palette.series[0];

  if (points.length === 0) return <NoData height={h} />;

  return (
    <ResponsiveContainer width="100%" height={h}>
      <ScatterChart margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
        <CartesianGrid {...gridProps(palette)} />
        <XAxis
          type="number"
          dataKey="size"
          name="Lines"
          {...axisProps(palette)}
          tickFormatter={compact}
          label={{
            value: "Lines changed",
            position: "insideBottom",
            offset: -2,
            fill: palette.inkMuted,
            fontSize: AXIS_FONT,
          }}
        />
        <YAxis
          type="number"
          dataKey="hours"
          name="Hours"
          {...axisProps(palette)}
          width={48}
          tickFormatter={compact}
          label={{
            value: "Hours to merge",
            angle: -90,
            position: "insideLeft",
            fill: palette.inkMuted,
            fontSize: AXIS_FONT,
          }}
        />
        <ZAxis type="number" dataKey="discussion" range={[36, 160]} />
        <Tooltip
          cursor={{ stroke: palette.baseline, strokeWidth: 1 }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as ScatterPoint;
            return (
              <TooltipShell
                palette={palette}
                heading={`${d.label} · ${d.detail}`}
                rows={[
                  { label: "lines changed", value: full(d.size), color },
                  { label: "hours to merge", value: compact(d.hours) },
                  { label: "comments + reviews", value: full(d.discussion) },
                ]}
              />
            );
          }}
        />
        <Scatter data={points} fill={color} fillOpacity={0.7} />
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/* ── Placeholder ───────────────────────────────────────────────────────────── */

export function NoData({
  height = 200,
  message = "No data for this selection",
  compactMessage = false,
}: {
  height?: number;
  message?: string;
  compactMessage?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-center rounded-md border border-dashed border-hairline"
      style={{ height }}
    >
      <span className={compactMessage ? "text-[10px] text-ink-muted" : "text-[12px] text-ink-secondary"}>
        {message}
      </span>
    </div>
  );
}
