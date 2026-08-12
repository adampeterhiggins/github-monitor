/**
 * Series colors for charts.
 *
 * These are the validated reference-palette values. Both modes are *selected*,
 * not derived by flipping lightness: the dark column is the same eight hues
 * re-stepped for the dark surface.
 *
 * Validation (OKLab ΔE ×100, Machado-Oliveira-Fernandes @ 1.0), adjacent pairlist:
 *   light — worst CVD 9.1, worst normal-vision 19.6, all PASS; contrast WARN on
 *           aqua/yellow/magenta (sub-3:1) which obligates the relief channel:
 *           every chart here ships direct labels and a table view.
 *   dark  — worst CVD 8.4, worst normal-vision 19.3, contrast all >= 3:1, all PASS.
 *
 * Rules that must hold at call sites:
 *   - assign slots in fixed order 1..8, never cycled; a 9th series folds to "Other"
 *   - color follows the entity, never its rank, so a filter never repaints survivors
 *   - scatter / small-multiple forms cap at THREE series (all-pairs is a harder
 *     gate that the full eight cannot clear)
 */

export type VizMode = "light" | "dark";

export interface VizPalette {
  mode: VizMode;
  /** Categorical identity slots, in fixed assignment order. */
  series: readonly string[];
  /** Single-hue magnitude ramp, light -> dark (sequential encoding). */
  sequential: readonly string[];
  /** Polarity around a baseline: two poles plus a neutral midpoint. */
  diverging: { positive: string; negative: string; mid: string };
  status: { good: string; warning: string; serious: string; critical: string };
  surface: string;
  plane: string;
  ink: string;
  inkSecondary: string;
  inkMuted: string;
  gridline: string;
  baseline: string;
  deltaUp: string;
  deltaDown: string;
}

const SERIES_LIGHT = [
  "#2a78d6", // 1 blue
  "#eb6834", // 2 orange
  "#1baf7a", // 3 aqua
  "#eda100", // 4 yellow
  "#e87ba4", // 5 magenta
  "#008300", // 6 green
  "#4a3aa7", // 7 violet
  "#e34948", // 8 red
] as const;

const SERIES_DARK = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
] as const;

/**
 * Blue 100..700. The full range is for *sequential* encoding, where the
 * lightest step means "near zero" and is allowed to recede toward the surface.
 * For an ordinal ramp start no lighter than index 3 (`#86b6ef`) on light.
 */
const SEQUENTIAL = [
  "#cde2fb",
  "#b7d3f6",
  "#9ec5f4",
  "#86b6ef",
  "#6da7ec",
  "#5598e7",
  "#3987e5",
  "#2a78d6",
  "#256abf",
  "#1c5cab",
  "#184f95",
  "#104281",
  "#0d366b",
] as const;

const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

export const LIGHT_PALETTE: VizPalette = {
  mode: "light",
  series: SERIES_LIGHT,
  sequential: SEQUENTIAL,
  diverging: { positive: "#2a78d6", negative: "#e34948", mid: "#f0efec" },
  status: STATUS,
  surface: "#fcfcfb",
  plane: "#f9f9f7",
  ink: "#0b0b0b",
  inkSecondary: "#52514e",
  inkMuted: "#898781",
  gridline: "#e1e0d9",
  baseline: "#c3c2b7",
  deltaUp: "#006300",
  deltaDown: "#d03b3b",
};

export const DARK_PALETTE: VizPalette = {
  mode: "dark",
  series: SERIES_DARK,
  sequential: SEQUENTIAL,
  diverging: { positive: "#3987e5", negative: "#e66767", mid: "#383835" },
  status: STATUS,
  surface: "#1a1a19",
  plane: "#0d0d0d",
  ink: "#ffffff",
  inkSecondary: "#c3c2b7",
  inkMuted: "#898781",
  gridline: "#2c2c2a",
  baseline: "#383835",
  deltaUp: "#0ca30c",
  deltaDown: "#e66767",
};

export function paletteFor(mode: VizMode): VizPalette {
  return mode === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
}

/**
 * Categorical slot for a series index. Past the eighth slot we deliberately
 * return null rather than cycling — callers fold the tail into "Other".
 */
export function seriesColor(palette: VizPalette, index: number): string | null {
  return index < palette.series.length ? palette.series[index] : null;
}

/**
 * Slot colour with the hues reused past the eighth.
 *
 * The rule above holds for anything drawn by default, and this does not replace
 * it: folding the tail into "Other" is still what the charts do unless asked
 * otherwise. But "show every repository separately" is a legitimate thing to want
 * from a chart of forty repositories, and there is no ninth hue to give it —
 * inventing one would break the validated adjacency, and greying the tail would
 * make forty series indistinguishable rather than merely repeated.
 *
 * So the caller can opt into repetition, on the understanding that colour stops
 * being unique: identity then comes from the legend, which is ordered and
 * clickable, from the tooltip, which names every band, and from the table view
 * that every chart ships. Repetition is at least honest about being repetition;
 * a fabricated hue would not be.
 */
export function seriesColorCycled(palette: VizPalette, index: number): string {
  return palette.series[index % palette.series.length];
}

export const OTHER_COLOR = { light: "#898781", dark: "#898781" } as const;

/** Max slots a scatter/small-multiple form may carry (all-pairs gate). */
export const ALL_PAIRS_SERIES_CAP = 3;

/**
 * Map a 0..1 magnitude onto the sequential ramp. `zeroIsEmpty` keeps true zeros
 * off the ramp entirely so "no activity" never reads as "a little activity".
 */
export function sequentialStep(
  palette: VizPalette,
  t: number,
  zeroIsEmpty = true,
): string | null {
  if (zeroIsEmpty && t <= 0) return null;
  const clamped = Math.max(0, Math.min(1, t));
  const idx = Math.round(clamped * (palette.sequential.length - 1));
  return palette.sequential[idx];
}
