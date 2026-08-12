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
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useMemo } from "react";
import { useVizPalette } from "../lib/viz/useVizPalette";
import { sequentialStep, type VizPalette } from "../lib/viz/palette";
import { formatShort, formatDate, weekTickFormatter } from "../lib/agg/weeks";
import { compact, full } from "./ui";

/* ── Shared chart chrome ────────────────────────────────────────────────────
   Mark specs are fixed: bars <= 24px with a 4px rounded data-end square at the
   baseline, 2px lines, hairline solid gridlines one step off the surface, and
   axis text in muted ink rather than any series color.                        */

const BAR_MAX = 24;
const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0];
const AXIS_FONT = 11;

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
  // One series: no legend box — the card title already names what is plotted.
  const color = palette.series[0];
  const tick = weekTickFormatter(data.map((d) => d.week));
  const geom = barGeometry(data.length, BAR_RADIUS);

  if (data.length === 0) return <NoData height={height} />;

  return (
    <ResponsiveContainer width="100%" height={height}>
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

/* ── Sparkline (contributor cards) ────────────────────────────────────────── */

export function Sparkline({
  data,
  height = 56,
  colorIndex = 0,
  metricLabel,
  yMax,
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
}) {
  const palette = useVizPalette();
  // Small multiples all carry the same single series, so the all-pairs series cap
  // does not bite here — every card is slot 1.
  const color = palette.series[colorIndex] ?? palette.series[0];
  const tick = weekTickFormatter(data.map((d) => d.week));
  const geom = barGeometry(data.length, [2, 2, 0, 0]);

  if (data.length === 0) return <NoData height={height} compactMessage />;

  return (
    <ResponsiveContainer width="100%" height={height}>
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
          domain={yMax != null ? [0, yMax] : undefined}
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

  if (data.length === 0) return <NoData height={height} />;

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
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
  const colored = series.map((s) => ({ ...s, color: palette.series[s.slot] ?? palette.inkMuted }));

  if (data.length === 0) return <NoData height={height} />;

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
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
  const colored = series.map((s) => ({ ...s, color: palette.series[s.slot] ?? palette.inkMuted }));

  if (data.length === 0) return <NoData height={height} />;

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
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
}: {
  data: Array<{ name: string; value: number }>;
  height?: number;
  valueLabel: string;
}) {
  const palette = useVizPalette();
  // Nominal categories: one hue for every bar. Coloring them by value would spend
  // the identity channel re-encoding what bar length already shows.
  const color = palette.series[0];
  const h = height ?? Math.max(120, data.length * 26 + 24);

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
        <XAxis type="number" {...axisProps(palette)} tickFormatter={compact} hide />
        <YAxis
          type="category"
          dataKey="name"
          {...axisProps(palette)}
          width={190}
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
                rows={[{ label: valueLabel, value: full(d.value), color }]}
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
            formatter: (v: unknown) => compact(Number(v ?? 0)),
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
  const colored = series.map((s) => ({ ...s, color: palette.series[s.slot] ?? palette.inkMuted }));

  if (data.length === 0) return <NoData height={height} />;

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
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
