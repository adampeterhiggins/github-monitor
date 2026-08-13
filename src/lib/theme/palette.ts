import "culori/css";
import { converter, parse } from "culori/fn";

export const DEFAULT_THEME_ID = "default" as const;
export const DEFAULT_THEME_LABEL = "Default";
export const THEME_FILE_VERSION = 1 as const;
export const CUSTOM_THEMES_STORAGE_KEY = "github-monitor.themes:v1";

export type ThemePreference = string;

export const THEME_COLOR_ROLES = [
  "canvas",
  "chrome",
  "toolbar",
  "toolbarForeground",
  "toolbarBorder",
  "toolbarControl",
  "toolbarControlForeground",
  "toolbarControlHover",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "text",
  "textMuted",
  "border",
  "input",
  "focus",
  "accent",
  "accentForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
  "accentSurface",
  "accentSurfaceForeground",
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "codeBackground",
  "codeForeground",
  "sidebar",
  "sidebarForeground",
  "sidebarMutedForeground",
  "sidebarControlSurface",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarRowSelected",
  "sidebarBorder",
  "terminalBackground",
  "terminalForeground",
  "terminalCursor",
  "terminalSelection",
  "terminalScrollbar",
  "terminalScrollbarHover",
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];
const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);
export type ThemeAppearance = "light" | "dark";

export type ThemeColors = Readonly<Record<ThemeColorRole, string>>;
export type ThemeColorOverrides = Readonly<Partial<Record<ThemeColorRole, string>>>;
export type ThemeVariants = Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>;
export type ThemeVariantOverrides = Readonly<Partial<Record<ThemeAppearance, ThemeColorOverrides>>>;
export type ThemePreferenceMode = ThemeAppearance | "system";
export type ThemeCollection = Readonly<{ id: string; label: string }>;
export type ThemeDefinition = Readonly<{
  id: string;
  label: string;
  appearance: ThemeAppearance;
  colors: ThemeColors;
  variants?: ThemeVariants;
  /** Groups related imported variants into one library card. */
  collection?: ThemeCollection;
  /** True when the palette was generated from canvas and accent seeds. */
  managed?: boolean;
}>;
export type ThemeFile = Readonly<{
  version: typeof THEME_FILE_VERSION;
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: ThemeColorOverrides;
  variants?: ThemeVariantOverrides;
  collection?: ThemeCollection;
  managed?: boolean;
}>;

const RESERVED_THEME_IDS = new Set(["system", "light", "dark", DEFAULT_THEME_ID]);

const customThemeListeners = new Set<() => void>();
type CustomThemeLibrarySnapshot =
  | Readonly<{
      status: "ready";
      storedThemes: ReadonlyArray<unknown>;
      themes: ReadonlyArray<ThemeDefinition>;
    }>
  | Readonly<{ status: "unavailable"; reason: "malformed" }>
  | Readonly<{ status: "unavailable"; reason: "storage-unavailable"; cause: unknown }>;

let customThemeLibrarySnapshot: CustomThemeLibrarySnapshot | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === "light" || value === "dark";
}

export function isThemeColor(value: unknown): value is string {
  return typeof value === "string" && toCanonicalThemeColor(value) !== null;
}

function isThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
}

function isThemeLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48;
}

function parseThemeCollection(value: unknown): ThemeCollection | undefined {
  return isRecord(value) &&
    typeof value.id === "string" &&
    /^[a-z0-9][a-z0-9.:-]{0,127}$/i.test(value.id) &&
    isThemeLabel(value.label)
    ? { id: value.id, label: value.label.trim() }
    : undefined;
}

function parseStoredThemeColors(value: unknown, appearance: ThemeAppearance): ThemeColors | null {
  if (!isRecord(value)) return null;

  const colors: Partial<Record<ThemeColorRole, string>> = {
    ...getDefaultThemeColors(appearance),
  };
  // Tolerate unknown roles and malformed values so themes saved by other
  // builds (for example one that adds a new role) keep their remaining colors.
  for (const [role, color] of Object.entries(value)) {
    const normalized = toCanonicalThemeColor(color);
    if (THEME_COLOR_ROLE_SET.has(role) && normalized) {
      colors[role as ThemeColorRole] = normalized;
    }
  }
  return colors as ThemeColors;
}

function parseStoredThemeVariants(
  value: unknown,
  baseAppearance: ThemeAppearance,
): ThemeVariants | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  for (const [appearance, colors] of Object.entries(value)) {
    if (!isThemeAppearance(appearance)) return null;
    // A variant matching the base appearance would be shadowed by the base
    // colors; drop it so the theme round-trips through parseThemeFile.
    if (appearance === baseAppearance) continue;
    const parsedColors = parseStoredThemeColors(colors, appearance);
    if (!parsedColors) return null;
    variants[appearance] = parsedColors;
  }
  return Object.keys(variants).length > 0 ? variants : undefined;
}

function parseStoredTheme(value: unknown): ThemeDefinition | null {
  if (!isRecord(value)) return null;
  if (!isThemeId(value.id) || RESERVED_THEME_IDS.has(value.id)) return null;
  if (!isThemeLabel(value.label) || !isThemeAppearance(value.appearance)) return null;
  const colors = parseStoredThemeColors(value.colors, value.appearance);
  if (!colors) return null;
  const variants = parseStoredThemeVariants(value.variants, value.appearance);
  if (value.variants !== undefined && variants === null) return null;
  const collection = parseThemeCollection(value.collection);

  return {
    id: value.id,
    label: value.label.trim(),
    appearance: value.appearance,
    colors,
    ...(variants ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

function parseStoredThemes(storedThemes: ReadonlyArray<unknown>): ReadonlyArray<ThemeDefinition> {
  const themes: ThemeDefinition[] = [];
  for (const value of storedThemes) {
    const theme = parseStoredTheme(value);
    if (theme && !themes.some((existing) => existing.id === theme.id)) {
      themes.push(theme);
    }
  }
  return themes;
}

function readCustomThemeLibrarySnapshot(): CustomThemeLibrarySnapshot {
  if (typeof window === "undefined") {
    return { status: "ready", storedThemes: [], themes: [] };
  }

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
  } catch (cause) {
    return { status: "unavailable", reason: "storage-unavailable", cause };
  }
  if (!raw) return { status: "ready", storedThemes: [], themes: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unavailable", reason: "malformed" };
  }
  if (!Array.isArray(parsed)) return { status: "unavailable", reason: "malformed" };

  return { status: "ready", storedThemes: parsed, themes: parseStoredThemes(parsed) };
}

function getCustomThemeLibrarySnapshot(): CustomThemeLibrarySnapshot {
  if (customThemeLibrarySnapshot === null) {
    customThemeLibrarySnapshot = readCustomThemeLibrarySnapshot();
  }
  return customThemeLibrarySnapshot;
}

function notifyCustomThemeListeners() {
  for (const listener of customThemeListeners) listener();
}

export function invalidateCustomThemes() {
  customThemeLibrarySnapshot = null;
  notifyCustomThemeListeners();
}

export function getCustomThemes(): ReadonlyArray<ThemeDefinition> {
  const snapshot = getCustomThemeLibrarySnapshot();
  return snapshot.status === "ready" ? snapshot.themes : [];
}

export function getStoredCustomThemeCollection(
  collectionId: string,
): ReadonlyArray<ThemeDefinition> {
  return readWritableCustomThemeLibrary().themes.filter(
    (theme) => theme.collection?.id === collectionId,
  );
}

export function subscribeToCustomThemes(listener: () => void): () => void {
  customThemeListeners.add(listener);
  if (typeof window === "undefined") {
    return () => customThemeListeners.delete(listener);
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_THEMES_STORAGE_KEY || event.key === null) {
      invalidateCustomThemes();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    customThemeListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function canonicalThemePreference(theme: string): string {
  return theme;
}

function themeIdFromPreference(theme: ThemePreference): string {
  return theme;
}

/**
 * Maintainer palettes use product color roles rather than Tailwind or component
 * names so the same definitions can feed other clients and native surfaces.
 */
/**
 * GitHub Monitor's own light and dark tokens, encoded as a full theme so
 * omitted VS Code roles fill from this look rather than an unrelated palette.
 */
const GITHUB_MONITOR_LIGHT_COLORS: ThemeColors = {
  canvas: "#f9f9f7",
  chrome: "#f9f9f7",
  toolbar: "#f9f9f7",
  toolbarForeground: "#0b0b0b",
  toolbarBorder: "#e1e0d9",
  toolbarControl: "#fcfcfb",
  toolbarControlForeground: "#0b0b0b",
  toolbarControlHover: "#ecece8",
  surface: "#fcfcfb",
  surfaceRaised: "#fcfcfb",
  surfaceOverlay: "#ffffff",
  text: "#0b0b0b",
  textMuted: "#898781",
  border: "#e1e0d9",
  input: "#c3c2b7",
  focus: "#2a78d6",
  accent: "#2a78d6",
  accentForeground: "#ffffff",
  secondary: "#f3f3f0",
  secondaryForeground: "#0b0b0b",
  muted: "#f3f3f0",
  mutedForeground: "#52514e",
  placeholder: "#898781",
  secondaryLabel: "#52514e",
  iconMuted: "#898781",
  error: "#d03b3b",
  errorForeground: "#d03b3b",
  errorSurface: "#fce8e8",
  warning: "#fab219",
  warningForeground: "#8a5a00",
  warningSurface: "#fff6e0",
  update: "#2a78d6",
  updateForeground: "#2a78d6",
  updateSurface: "#e8f1fb",
  accentSurface: "#e8f1fb",
  accentSurfaceForeground: "#0b0b0b",
  messageSurface: "#e8f1fb",
  messageForeground: "#0b0b0b",
  messageAction: "#2a78d6",
  messageActionForeground: "#ffffff",
  messageActionHover: "#256abf",
  codeBackground: "#f3f3f0",
  codeForeground: "#0b0b0b",
  sidebar: "#f9f9f7",
  sidebarForeground: "#0b0b0b",
  sidebarMutedForeground: "#898781",
  sidebarControlSurface: "#f3f3f0",
  sidebarRowHover: "#f3f3f0",
  sidebarRowActive: "#ecece8",
  sidebarRowSelected: "#ecece8",
  sidebarBorder: "#e1e0d9",
  terminalBackground: "#f9f9f7",
  terminalForeground: "#0b0b0b",
  terminalCursor: "#2a78d6",
  terminalSelection: "#d6e6f8",
  terminalScrollbar: "#c3c2b7",
  terminalScrollbarHover: "#898781",
};

const GITHUB_MONITOR_DARK_COLORS: ThemeColors = {
  canvas: "#0d0d0d",
  chrome: "#0d0d0d",
  toolbar: "#0d0d0d",
  toolbarForeground: "#ffffff",
  toolbarBorder: "#2c2c2a",
  toolbarControl: "#1a1a19",
  toolbarControlForeground: "#ffffff",
  toolbarControlHover: "#242422",
  surface: "#1a1a19",
  surfaceRaised: "#1a1a19",
  surfaceOverlay: "#242422",
  text: "#ffffff",
  textMuted: "#898781",
  border: "#2c2c2a",
  input: "#383835",
  focus: "#3987e5",
  accent: "#3987e5",
  accentForeground: "#ffffff",
  secondary: "#242422",
  secondaryForeground: "#ffffff",
  muted: "#242422",
  mutedForeground: "#c3c2b7",
  placeholder: "#898781",
  secondaryLabel: "#c3c2b7",
  iconMuted: "#898781",
  error: "#e66767",
  errorForeground: "#e66767",
  errorSurface: "#3a1e1e",
  warning: "#fab219",
  warningForeground: "#fab219",
  warningSurface: "#3a2e14",
  update: "#3987e5",
  updateForeground: "#3987e5",
  updateSurface: "#1a2838",
  accentSurface: "#1a2838",
  accentSurfaceForeground: "#ffffff",
  messageSurface: "#1a2838",
  messageForeground: "#ffffff",
  messageAction: "#3987e5",
  messageActionForeground: "#ffffff",
  messageActionHover: "#2a78d6",
  codeBackground: "#1a1a19",
  codeForeground: "#ffffff",
  sidebar: "#0d0d0d",
  sidebarForeground: "#ffffff",
  sidebarMutedForeground: "#898781",
  sidebarControlSurface: "#1a1a19",
  sidebarRowHover: "#1a1a19",
  sidebarRowActive: "#242422",
  sidebarRowSelected: "#242422",
  sidebarBorder: "#2c2c2a",
  terminalBackground: "#0d0d0d",
  terminalForeground: "#ffffff",
  terminalCursor: "#3987e5",
  terminalSelection: "#1a2838",
  terminalScrollbar: "#383835",
  terminalScrollbarHover: "#52514e",
};

export function getStandardThemeColors(appearance: ThemeAppearance): ThemeColors {
  if (appearance === "dark") {
    return (standardDarkThemeColors ??= decodeThemeColors(GITHUB_MONITOR_DARK_COLORS));
  }
  return (standardLightThemeColors ??= decodeThemeColors(GITHUB_MONITOR_LIGHT_COLORS));
}

type ThemeRgbColor = {
  r: number;
  g: number;
  b: number;
};

type ThemeHslColor = {
  h: number;
  s: number;
  l: number;
};

type ThemeOklch = { L: number; C: number; h: number };
type ParsedThemeColor = { color: ThemeOklch; alpha: number };

let standardLightThemeColors: ThemeColors | undefined;
let standardDarkThemeColors: ThemeColors | undefined;

const THEME_LIGHT_FOREGROUND: ThemeRgbColor = { r: 255, g: 250, b: 255 };
const THEME_DARK_FOREGROUND: ThemeRgbColor = { r: 36, g: 21, b: 35 };
const THEME_WHITE_FOREGROUND: ThemeRgbColor = { r: 255, g: 255, b: 255 };
const THEME_BLACK_FOREGROUND: ThemeRgbColor = { r: 0, g: 0, b: 0 };

const convertToOklch = converter("oklch");

function parseThemeColor(value: unknown): ParsedThemeColor | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  const parsed = parse(input);
  if (!parsed) return null;
  const color = convertToOklch(parsed);
  const lightness = color.l ?? 0;
  const chroma = color.c ?? 0;
  const hue = color.h ?? 0;
  // CSS missing components behave as zero outside interpolation. Culori omits
  // a `none` alpha from its parsed object, so distinguish it from omitted alpha.
  const alpha = /\/\s*none\s*\)$/i.test(input) ? 0 : (color.alpha ?? 1);
  if (![lightness, chroma, hue, alpha].every(Number.isFinite)) return null;
  return {
    color: {
      L: Math.min(1, Math.max(0, lightness)),
      C: Math.max(0, chroma),
      h: hue,
    },
    alpha: Math.min(1, Math.max(0, alpha)),
  };
}

function formatThemeColorNumber(value: number, precision: number): string {
  const rounded = Math.abs(value) < 10 ** -precision / 2 ? 0 : value;
  return rounded.toFixed(precision).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/, "$1");
}

function formatOklchThemeColor(color: ThemeOklch, alpha = 1): string {
  const normalizedHue = color.C < 0.0000005 ? 0 : ((color.h % 360) + 360) % 360;
  const body = `${formatThemeColorNumber(color.L, 6)} ${formatThemeColorNumber(color.C, 6)} ${formatThemeColorNumber(normalizedHue, 3)}`;
  return alpha < 1 ? `oklch(${body} / ${formatThemeColorNumber(alpha, 4)})` : `oklch(${body})`;
}

/**
 * Decode a literal CSS color into the runtime's canonical OKLCH form. Stored
 * values use this path in memory without mutating localStorage.
 */
export function toCanonicalThemeColor(value: unknown): string | null {
  const parsed = parseThemeColor(value);
  return parsed ? formatOklchThemeColor(parsed.color, parsed.alpha) : null;
}

/** Convert a runtime theme color for hex-only editor and import adapters. */
export function themeColorToHex(value: string): string | null {
  const color = parseThemeColor(value);
  const parsed = color ? { rgb: themeOklchToRgb(color.color), alpha: color.alpha } : null;
  if (!parsed) return null;

  const opaque = themeRgbToHexColor(parsed.rgb);
  if (parsed.alpha >= 1) return opaque;
  const alpha = Math.round(parsed.alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${opaque}${alpha}`;
}

function parseThemeRgbColor(value: string, fallback: ThemeRgbColor): ThemeRgbColor {
  const parsed = parseThemeColor(value);
  return parsed ? themeOklchToRgb(parsed.color) : fallback;
}

function themeRgbToHexColor(color: ThemeRgbColor): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function themeRgbToThemeColor(color: ThemeRgbColor): string {
  return formatOklchThemeColor(themeRgbToOklch(color));
}

function decodeThemeColors(colors: ThemeColors): ThemeColors {
  return Object.fromEntries(
    THEME_COLOR_ROLES.map((role) => {
      const color = toCanonicalThemeColor(colors[role]);
      if (!color) {
        throw new Error(
          `The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`,
        );
      }
      return [role, color];
    }),
  ) as Record<ThemeColorRole, string>;
}

function canonicalizeThemeDefinition(theme: ThemeDefinition): ThemeDefinition {
  return {
    ...theme,
    colors: decodeThemeColors(theme.colors),
    ...(theme.variants
      ? {
          variants: Object.fromEntries(
            Object.entries(theme.variants).map(([appearance, colors]) => [
              appearance,
              decodeThemeColors(colors),
            ]),
          ) as ThemeVariants,
        }
      : {}),
  };
}

function themeRgbToHsl(color: ThemeRgbColor): ThemeHslColor {
  const red = color.r / 255;
  const green = color.g / 255;
  const blue = color.b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (delta === 0) return { h: 0, s: 0, l: lightness };

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;

  return { h: (hue * 60 + 360) % 360, s: saturation, l: lightness };
}

function themeHslToRgb(color: ThemeHslColor): ThemeRgbColor {
  const hue = ((color.h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * color.l - 1)) * color.s;
  const hueSector = hue / 60;
  const secondary = chroma * (1 - Math.abs((hueSector % 2) - 1));
  const match = color.l - chroma / 2;
  const [red, green, blue] =
    hueSector < 1
      ? [chroma, secondary, 0]
      : hueSector < 2
        ? [secondary, chroma, 0]
        : hueSector < 3
          ? [0, chroma, secondary]
          : hueSector < 4
            ? [0, secondary, chroma]
            : hueSector < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];

  return { r: (red + match) * 255, g: (green + match) * 255, b: (blue + match) * 255 };
}

function mixThemeRgbColors(
  base: ThemeRgbColor,
  overlay: ThemeRgbColor,
  amount: number,
): ThemeRgbColor {
  return {
    r: base.r + (overlay.r - base.r) * amount,
    g: base.g + (overlay.g - base.g) * amount,
    b: base.b + (overlay.b - base.b) * amount,
  };
}

function themeRelativeLuminance(color: ThemeRgbColor): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

// ---------------------------------------------------------------------------
// Vivid palette engine: perceptual (OKLCH) derivation for user-created themes.

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(channel: number): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

function themeRgbToOklch(color: ThemeRgbColor): ThemeOklch {
  const r = srgbChannelToLinear(color.r);
  const g = srgbChannelToLinear(color.g);
  const b = srgbChannelToLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
}

function oklchToRgbUnclamped({ L, C, h }: ThemeOklch): { r: number; g: number; b: number } {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const bb = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/** Find the greatest chroma along the same lightness and hue that fits in sRGB. */
function mapThemeOklchToSrgbGamut(color: ThemeOklch): ThemeOklch {
  const isInGamut = (C: number) => {
    const linear = oklchToRgbUnclamped({ ...color, C });
    return [linear.r, linear.g, linear.b].every(
      (channel) => channel >= -0.0001 && channel <= 1.0001,
    );
  };
  if (isInGamut(color.C)) return color;

  let low = 0;
  let high = color.C;
  const steps = Math.max(1, Math.ceil(Math.log2(Math.max(color.C, 0.000001) / 0.000001)));
  for (let step = 0; step < steps; step += 1) {
    const mid = (low + high) / 2;
    if (isInGamut(mid)) low = mid;
    else high = mid;
  }
  return { ...color, C: low };
}

/** Convert to sRGB after applying the palette engine's gamut mapping. */
function themeOklchToRgb(color: ThemeOklch): ThemeRgbColor {
  const linear = oklchToRgbUnclamped(mapThemeOklchToSrgbGamut(color));
  return {
    r: linearChannelToSrgb(linear.r),
    g: linearChannelToSrgb(linear.g),
    b: linearChannelToSrgb(linear.b),
  };
}

function themeOklchToThemeColor(color: ThemeOklch): string {
  return formatOklchThemeColor(mapThemeOklchToSrgbGamut(color));
}

/** Binary-search the lightness that reaches the contrast target against a background. */
function solveOklchLightness(
  base: ThemeOklch,
  against: ThemeRgbColor,
  minContrast: number,
  direction: "lighter" | "darker",
): ThemeOklch {
  let low = direction === "lighter" ? base.L : 0;
  let high = direction === "lighter" ? 1 : base.L;
  let candidate = { ...base };
  if (themeContrastRatio(themeOklchToRgb(candidate), against) >= minContrast) return candidate;
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2;
    candidate = { ...base, L: mid };
    const contrast = themeContrastRatio(themeOklchToRgb(candidate), against);
    if (contrast >= minContrast) {
      if (direction === "lighter") high = mid;
      else low = mid;
    } else {
      if (direction === "lighter") low = mid;
      else high = mid;
    }
  }
  return { ...base, L: direction === "lighter" ? high : low };
}

/**
 * The status colors T3 Code shows without a theme, read from the app's own
 * tokens (red-500 / amber-500 families). Generated palettes fall back to
 * these instead of the flagship theme's, so an imported or created theme
 * never inherits a brand tint on destructive buttons and warnings.
 */
const STANDARD_STATUS_COLORS = {
  light: {
    error: "#fb2c36",
    errorForeground: "#c10007",
    warning: "#fe9a00",
    warningForeground: "#bb4d00",
  },
  dark: {
    error: "#fb414a",
    errorForeground: "#ff6467",
    warning: "#fe9a00",
    warningForeground: "#ffb900",
  },
} as const;

/**
 * Status surfaces are the standard color laid over the theme's own canvas
 * (the unthemed app uses 8% in light and 16% in dark), so alerts still sit on
 * the palette while the signal color stays standard.
 */
function standardStatusColors(canvas: ThemeRgbColor): {
  error: string;
  errorForeground: string;
  errorSurface: string;
  warning: string;
  warningForeground: string;
  warningSurface: string;
} {
  // Keyed off the canvas rather than the appearance slot: a dark canvas saved
  // as a light theme still needs the dark pair, or the alert foreground lands
  // on a dark surface unreadable.
  const appearance: ThemeAppearance = themeRelativeLuminance(canvas) < 0.179 ? "dark" : "light";
  const standard = STANDARD_STATUS_COLORS[appearance];
  const surfaceMix = appearance === "dark" ? 0.16 : 0.08;
  const surfaceOf = (value: string) =>
    mixThemeRgbColors(canvas, parseThemeRgbColor(value, canvas), surfaceMix);
  // The standard foregrounds are tuned against the unthemed canvas; on a
  // tinted one they can fall just short, so lightness is nudged until the
  // pair clears 4.5 while the hue stays standard.
  const readableOn = (foreground: string, surface: ThemeRgbColor) =>
    themeOklchToThemeColor(
      solveOklchLightness(
        themeRgbToOklch(parseThemeRgbColor(foreground, canvas)),
        surface,
        // Leave a little headroom for browser color conversion at render time.
        4.6,
        appearance === "dark" ? "lighter" : "darker",
      ),
    );
  const errorSurface = surfaceOf(standard.error);
  const warningSurface = surfaceOf(standard.warning);
  return {
    error: toCanonicalThemeColor(standard.error)!,
    errorForeground: readableOn(standard.errorForeground, errorSurface),
    errorSurface: themeRgbToThemeColor(errorSurface),
    warning: toCanonicalThemeColor(standard.warning)!,
    warningForeground: readableOn(standard.warningForeground, warningSurface),
    warningSurface: themeRgbToThemeColor(warningSurface),
  };
}

/**
 * Derive a full palette from two exact seed colors, in OKLCH. Surfaces climb a
 * perceptually even lightness ramp that carries the accent hue at low chroma,
 * a companion action color is rotated off the accent, and every foreground is
 * contrast-solved against its own surface.
 */
export function createVividThemeColors(
  appearance: ThemeAppearance,
  backgroundValue: string,
  accentValue: string,
): ThemeColors {
  const defaults = getDefaultThemeColors(appearance);
  const canvasRgb = parseThemeRgbColor(
    backgroundValue,
    appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
  );
  const accentRgb = parseThemeRgbColor(accentValue, { r: 168, g: 67, b: 112 });
  const canvas = themeRgbToOklch(canvasRgb);
  const accent = themeRgbToOklch(accentRgb);
  // The ramp and every contrast search follow the canvas the user actually
  // picked, not the appearance slot, so a dark canvas saved as a light theme
  // still gets light text and raised surfaces. 0.179 is the relative
  // luminance where white and black text have equal contrast headroom.
  const dark = themeRelativeLuminance(canvasRgb) < 0.179;
  const hue = accent.C < 0.02 ? canvas.h : accent.h;
  const tintC = Math.min(0.045, Math.max(0.008, accent.C * 0.22));
  const step = dark ? 1 : -1;

  const surfaceAt = (deltaL: number, chroma = tintC): ThemeOklch => ({
    L: Math.min(0.98, Math.max(0.05, canvas.L + step * deltaL)),
    C: chroma,
    h: hue,
  });
  const themeColor = (color: ThemeOklch) => themeOklchToThemeColor(color);

  // Text carries a whisper of the accent hue instead of falling back to a
  // fixed foreground, and is solved to WCAG AAA against the canvas.
  const textBase: ThemeOklch = {
    L: dark ? 0.95 : 0.2,
    C: Math.min(0.035, accent.C * 0.25),
    h: hue,
  };
  const text = solveOklchLightness(textBase, canvasRgb, 7, dark ? "lighter" : "darker");
  const textRgb = themeOklchToRgb(text);
  const textMutedRgb = standardMutedThemeText(canvasRgb, textRgb);

  // The companion action rotates off the accent so a two-color theme still
  // gets the dual-voice character of the hand-tuned palettes.
  const action: ThemeOklch = {
    L: Math.min(0.85, Math.max(0.35, accent.L + (dark ? 0.06 : -0.02))),
    C: Math.max(accent.C * 0.9, 0.06),
    h: (hue + 50) % 360,
  };
  const actionRgb = themeOklchToRgb(action);
  const actionForeground = readableThemeForeground(actionRgb);
  const accentForeground = readableThemeForeground(accentRgb);

  const sidebar = surfaceAt(0.045, tintC * 1.4);
  const sidebarRgb = themeOklchToRgb(sidebar);
  const surface = surfaceAt(0.015);
  const surfaceRaised = surfaceAt(0.05);
  const surfaceRaisedRgb = themeOklchToRgb(surfaceRaised);
  const surfaceOverlay = surfaceAt(0.075);
  const border = surfaceAt(dark ? 0.16 : 0.12, Math.min(0.07, accent.C * 0.35));
  const input = surfaceAt(dark ? 0.21 : 0.16, Math.min(0.08, accent.C * 0.4));
  const secondary = surfaceAt(dark ? 0.1 : 0.06, Math.min(0.09, accent.C * 0.5));
  const secondaryRgb = themeOklchToRgb(secondary);
  const muted = surfaceAt(dark ? 0.06 : 0.04, Math.min(0.06, accent.C * 0.35));
  const mutedRgb = themeOklchToRgb(muted);
  const accentSurface = surfaceAt(dark ? 0.13 : 0.08, Math.min(0.11, accent.C * 0.55));
  const accentSurfaceRgb = themeOklchToRgb(accentSurface);
  const messageSurface = surfaceAt(dark ? 0.16 : 0.1, Math.min(0.13, accent.C * 0.6));
  const messageSurfaceRgb = themeOklchToRgb(messageSurface);
  const codeBackground = surfaceAt(0.035, tintC * 0.8);
  const updateSurface = surfaceAt(dark ? 0.14 : 0.09, Math.min(0.12, accent.C * 0.55));

  const foregroundOn = (surfaceRgb: ThemeRgbColor): string =>
    themeOklchToThemeColor(
      solveOklchLightness(textBase, surfaceRgb, 4.6, dark ? "lighter" : "darker"),
    );
  const mutedForeground = foregroundOn(mutedRgb);
  const placeholder = foregroundOn(surfaceRaisedRgb);

  const actionHover: ThemeOklch = { ...action, L: action.L + (dark ? 0.06 : -0.06) };

  return {
    ...defaults,
    ...standardStatusColors(canvasRgb),
    canvas: themeRgbToThemeColor(canvasRgb),
    // The top bar shares the canvas so the main panel reads as one surface.
    chrome: themeRgbToThemeColor(canvasRgb),
    toolbar: themeRgbToThemeColor(canvasRgb),
    toolbarForeground: themeRgbToThemeColor(textRgb),
    toolbarBorder: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.08, accent.C * 0.4))),
    toolbarControl: themeColor(surfaceAt(dark ? 0.09 : 0.05, tintC * 1.3)),
    toolbarControlForeground: themeRgbToThemeColor(textRgb),
    toolbarControlHover: themeColor(surfaceAt(dark ? 0.14 : 0.09, tintC * 1.6)),
    surface: themeColor(surface),
    surfaceRaised: themeColor(surfaceRaised),
    surfaceOverlay: themeColor(surfaceOverlay),
    text: themeRgbToThemeColor(textRgb),
    textMuted: themeRgbToThemeColor(textMutedRgb),
    border: themeColor(border),
    input: themeColor(input),
    focus: themeRgbToThemeColor(accentRgb),
    accent: themeRgbToThemeColor(accentRgb),
    accentForeground: themeRgbToThemeColor(accentForeground),
    secondary: themeColor(secondary),
    secondaryForeground: foregroundOn(secondaryRgb),
    muted: themeColor(muted),
    mutedForeground,
    placeholder,
    secondaryLabel: themeRgbToThemeColor(textMutedRgb),
    iconMuted: themeRgbToThemeColor(textMutedRgb),
    update: themeRgbToThemeColor(accentRgb),
    updateForeground: foregroundOn(themeOklchToRgb(updateSurface)),
    updateSurface: themeColor(updateSurface),
    accentSurface: themeColor(accentSurface),
    accentSurfaceForeground: foregroundOn(accentSurfaceRgb),
    messageSurface: themeColor(messageSurface),
    messageForeground: foregroundOn(messageSurfaceRgb),
    messageAction: themeRgbToThemeColor(actionRgb),
    messageActionForeground: themeRgbToThemeColor(actionForeground),
    messageActionHover: themeColor(actionHover),
    codeBackground: themeColor(codeBackground),
    codeForeground: themeRgbToThemeColor(textRgb),
    sidebar: themeColor(sidebar),
    sidebarForeground: foregroundOn(sidebarRgb),
    sidebarMutedForeground: themeRgbToThemeColor(standardMutedThemeText(sidebarRgb, textRgb)),
    sidebarControlSurface: themeColor(surfaceAt(dark ? 0.1 : 0.07, tintC * 1.5)),
    sidebarRowHover: themeColor(surfaceAt(dark ? 0.08 : 0.06, Math.min(0.08, accent.C * 0.45))),
    sidebarRowActive: themeColor(surfaceAt(dark ? 0.12 : 0.09, Math.min(0.1, accent.C * 0.55))),
    sidebarRowSelected: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.11, accent.C * 0.6))),
    sidebarBorder: themeColor(surfaceAt(dark ? 0.17 : 0.12, Math.min(0.08, accent.C * 0.4))),
    terminalBackground: themeRgbToThemeColor(canvasRgb),
    terminalForeground: themeRgbToThemeColor(textRgb),
    terminalCursor: themeRgbToThemeColor(accentRgb),
    terminalSelection: themeColor(surfaceAt(dark ? 0.18 : 0.12, Math.min(0.12, accent.C * 0.55))),
    terminalScrollbar: themeColor(surfaceAt(dark ? 0.22 : 0.16, tintC)),
    terminalScrollbarHover: themeColor(surfaceAt(dark ? 0.3 : 0.22, tintC)),
  };
}

function themeContrastRatio(first: ThemeRgbColor, second: ThemeRgbColor): number {
  const firstLuminance = themeRelativeLuminance(first);
  const secondLuminance = themeRelativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function readableThemeForeground(background: ThemeRgbColor): ThemeRgbColor {
  const lightContrast = themeContrastRatio(background, THEME_LIGHT_FOREGROUND);
  const darkContrast = themeContrastRatio(background, THEME_DARK_FOREGROUND);
  if (Math.max(lightContrast, darkContrast) >= 4.5) {
    return lightContrast >= darkContrast ? THEME_LIGHT_FOREGROUND : THEME_DARK_FOREGROUND;
  }

  return themeContrastRatio(background, THEME_WHITE_FOREGROUND) >=
    themeContrastRatio(background, THEME_BLACK_FOREGROUND)
    ? THEME_WHITE_FOREGROUND
    : THEME_BLACK_FOREGROUND;
}

function readableThemeText(
  background: ThemeRgbColor,
  foreground: ThemeRgbColor,
  amount: number,
  minimumRatio: number,
): ThemeRgbColor {
  const softened = mixThemeRgbColors(foreground, background, amount);
  if (themeContrastRatio(softened, background) >= minimumRatio) return softened;

  // Find the quietest point between the requested mix and the primary
  // foreground that still clears the contrast floor. Returning the primary
  // foreground here made secondary labels jump from slightly too dim to full
  // brightness, which is especially conspicuous in dark custom themes.
  let readable = foreground;
  let lowerAmount = 0;
  let upperAmount = amount;
  for (let index = 0; index < 12; index += 1) {
    const candidateAmount = (lowerAmount + upperAmount) / 2;
    const candidate = mixThemeRgbColors(foreground, background, candidateAmount);
    if (themeContrastRatio(candidate, background) >= minimumRatio) {
      readable = candidate;
      lowerAmount = candidateAmount;
    } else {
      upperAmount = candidateAmount;
    }
  }
  return readable;
}

// Match the perceived strength of the stock palettes rather than choosing an
// arbitrary foreground mix. These are the measured contrast ratios of zinc-500
// on the standard light canvas and #818181 on the standard dark canvas.
const STANDARD_LIGHT_MUTED_CONTRAST = 4.705;
const STANDARD_DARK_MUTED_CONTRAST = 5.082;

function standardMutedThemeText(
  background: ThemeRgbColor,
  foreground: ThemeRgbColor,
): ThemeRgbColor {
  const target =
    themeRelativeLuminance(background) < 0.179
      ? STANDARD_DARK_MUTED_CONTRAST
      : STANDARD_LIGHT_MUTED_CONTRAST;
  return readableThemeText(background, foreground, 1, target);
}

function managedThemeBackground(value: string, appearance: ThemeAppearance): ThemeRgbColor {
  const selected = parseThemeRgbColor(
    value,
    appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
  );
  const hsl = themeRgbToHsl(selected);
  return themeHslToRgb({
    h: hsl.h,
    // A background tint should support the selected mode, not turn the whole
    // app into a high-saturation surface.
    s: Math.min(hsl.s, appearance === "dark" ? 0.3 : 0.2),
    l:
      appearance === "dark"
        ? Math.min(0.13, Math.max(0.07, hsl.l))
        : Math.min(0.985, Math.max(0.94, hsl.l)),
  });
}

function managedThemeAccent(
  value: string,
  appearance: ThemeAppearance,
  background: ThemeRgbColor,
): ThemeRgbColor {
  const selected = parseThemeRgbColor(value, { r: 168, g: 67, b: 112 });
  const hsl = themeRgbToHsl(selected);
  const preferredLightness =
    appearance === "dark"
      ? Math.min(0.72, Math.max(0.42, hsl.l))
      : Math.min(0.58, Math.max(0.35, hsl.l));
  const lightnessRange: readonly [number, number] =
    appearance === "dark" ? [0.42, 0.82] : [0.22, 0.58];
  const saturation = Math.min(hsl.s, 0.82);
  const candidates = Array.from({ length: 61 }, (_, index) => {
    const lightness =
      lightnessRange[0] + ((lightnessRange[1] - lightnessRange[0]) * index) / (61 - 1);
    const color = themeHslToRgb({ h: hsl.h, s: saturation, l: lightness });
    return { color, lightness, contrast: themeContrastRatio(color, background) };
  });
  // Leave a little room for browser color conversion at render time.
  const readableCandidates = candidates.filter((candidate) => candidate.contrast >= 4.7);
  const pool = readableCandidates.length > 0 ? readableCandidates : candidates;

  return pool.reduce((best, candidate) => {
    const distance = Math.abs(candidate.lightness - preferredLightness);
    const bestDistance = Math.abs(best.lightness - preferredLightness);
    return distance < bestDistance ||
      (distance === bestDistance && candidate.contrast > best.contrast)
      ? candidate
      : best;
  }).color;
}

/**
 * Creates the guided palette used by the basic theme editor. The two user
 * colors control the mood, while dependent roles are generated together so
 * text, surfaces, message actions, code, and terminal UI stay coherent.
 */
export function createManagedThemeColors(
  appearance: ThemeAppearance,
  backgroundValue: string,
  accentValue: string,
  options?: {
    /** Use the seeds exactly as given instead of nudging them into the
     * readability envelope. Derived foregrounds still adapt for contrast. */
    exactSeeds?: boolean;
  },
): ThemeColors {
  const defaults = getDefaultThemeColors(appearance);
  const canvas = options?.exactSeeds
    ? parseThemeRgbColor(
        backgroundValue,
        appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
      )
    : managedThemeBackground(backgroundValue, appearance);
  const accent = options?.exactSeeds
    ? parseThemeRgbColor(accentValue, { r: 168, g: 67, b: 112 })
    : managedThemeAccent(accentValue, appearance, canvas);
  const text = readableThemeForeground(canvas);
  const textMuted = standardMutedThemeText(canvas, text);
  // The top bar is part of the main panel, not a separate chrome layer: it
  // shares the canvas, and its controls sit on the panel's own surfaces.
  const chrome = canvas;
  const sidebar = mixThemeRgbColors(canvas, accent, 0.08);
  const surfaceRaised = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.12 : 0.035);
  const surfaceOverlay = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.18 : 0.06);
  const secondary = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.2 : 0.08);
  const muted = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.13 : 0.06);
  const mutedForeground = readableThemeText(muted, text, 1, 4.6);
  const placeholder = readableThemeText(surfaceRaised, text, 1, 4.6);
  const accentSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.3 : 0.14);
  const messageSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.36 : 0.18);
  const toolbarControl = mixThemeRgbColors(chrome, accent, appearance === "dark" ? 0.2 : 0.08);
  const toolbarBorder = mixThemeRgbColors(chrome, accent, appearance === "dark" ? 0.35 : 0.14);
  const accentForeground = readableThemeForeground(accent);
  // Code and terminal are large surfaces: they keep the canvas hue instead of
  // drifting toward the foreground grey. Code sits just above the canvas —
  // a whisper of the text tint — and the terminal sits on the canvas itself.
  const codeBackground = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.06 : 0.025);
  const terminalBackground = canvas;
  const messageActionHover = mixThemeRgbColors(
    accent,
    accentForeground === THEME_LIGHT_FOREGROUND || accentForeground === THEME_WHITE_FOREGROUND
      ? THEME_BLACK_FOREGROUND
      : THEME_WHITE_FOREGROUND,
    0.12,
  );

  // The update family follows the accent instead of inheriting the default
  // palette's brand color, so generated themes carry their own identity in
  // update pills and banners. Error and warning stay semantic defaults.
  const updateSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.32 : 0.16);
  const updateForeground = mixThemeRgbColors(
    accent,
    appearance === "dark" ? THEME_WHITE_FOREGROUND : THEME_BLACK_FOREGROUND,
    0.35,
  );

  return {
    ...defaults,
    ...standardStatusColors(canvas),
    update: themeRgbToThemeColor(accent),
    updateForeground: themeRgbToThemeColor(updateForeground),
    updateSurface: themeRgbToThemeColor(updateSurface),
    canvas: themeRgbToThemeColor(canvas),
    chrome: themeRgbToThemeColor(chrome),
    toolbar: themeRgbToThemeColor(chrome),
    toolbarForeground: themeRgbToThemeColor(text),
    toolbarBorder: themeRgbToThemeColor(toolbarBorder),
    toolbarControl: themeRgbToThemeColor(toolbarControl),
    toolbarControlForeground: themeRgbToThemeColor(text),
    toolbarControlHover: themeRgbToThemeColor(accentSurface),
    surface: themeRgbToThemeColor(canvas),
    surfaceRaised: themeRgbToThemeColor(surfaceRaised),
    surfaceOverlay: themeRgbToThemeColor(surfaceOverlay),
    text: themeRgbToThemeColor(text),
    textMuted: themeRgbToThemeColor(textMuted),
    // Borders blend through the accent before lightening so control chrome
    // carries the theme hue like the hand-tuned palettes (#5c345b, #e0d3e1)
    // instead of flattening to grey.
    border: themeRgbToThemeColor(
      mixThemeRgbColors(
        mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.22 : 0.1),
        text,
        0.1,
      ),
    ),
    input: themeRgbToThemeColor(
      mixThemeRgbColors(
        mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.3 : 0.14),
        text,
        appearance === "dark" ? 0.14 : 0.13,
      ),
    ),
    focus: themeRgbToThemeColor(accent),
    accent: themeRgbToThemeColor(accent),
    accentForeground: themeRgbToThemeColor(accentForeground),
    secondary: themeRgbToThemeColor(secondary),
    secondaryForeground: themeRgbToThemeColor(readableThemeForeground(secondary)),
    muted: themeRgbToThemeColor(muted),
    mutedForeground: themeRgbToThemeColor(mutedForeground),
    placeholder: themeRgbToThemeColor(placeholder),
    secondaryLabel: themeRgbToThemeColor(textMuted),
    iconMuted: themeRgbToThemeColor(textMuted),
    accentSurface: themeRgbToThemeColor(accentSurface),
    accentSurfaceForeground: themeRgbToThemeColor(readableThemeForeground(accentSurface)),
    messageSurface: themeRgbToThemeColor(messageSurface),
    messageForeground: themeRgbToThemeColor(readableThemeForeground(messageSurface)),
    messageAction: themeRgbToThemeColor(accent),
    messageActionForeground: themeRgbToThemeColor(accentForeground),
    messageActionHover: themeRgbToThemeColor(messageActionHover),
    codeBackground: themeRgbToThemeColor(codeBackground),
    codeForeground: themeRgbToThemeColor(readableThemeForeground(codeBackground)),
    sidebar: themeRgbToThemeColor(sidebar),
    sidebarForeground: themeRgbToThemeColor(readableThemeForeground(sidebar)),
    sidebarMutedForeground: themeRgbToThemeColor(standardMutedThemeText(sidebar, text)),
    sidebarControlSurface: themeRgbToThemeColor(
      mixThemeRgbColors(sidebar, text, appearance === "dark" ? 0.16 : 0.08),
    ),
    sidebarRowHover: themeRgbToThemeColor(mixThemeRgbColors(sidebar, accent, 0.12)),
    sidebarRowActive: themeRgbToThemeColor(mixThemeRgbColors(sidebar, accent, 0.2)),
    sidebarRowSelected: themeRgbToThemeColor(mixThemeRgbColors(sidebar, accent, 0.24)),
    sidebarBorder: themeRgbToThemeColor(
      mixThemeRgbColors(sidebar, text, appearance === "dark" ? 0.35 : 0.12),
    ),
    terminalBackground: themeRgbToThemeColor(terminalBackground),
    terminalForeground: themeRgbToThemeColor(readableThemeForeground(terminalBackground)),
    terminalCursor: themeRgbToThemeColor(accent),
    terminalSelection: themeRgbToThemeColor(
      mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.35 : 0.18),
    ),
    terminalScrollbar: themeRgbToThemeColor(
      mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.42 : 0.22),
    ),
    terminalScrollbarHover: themeRgbToThemeColor(
      mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.55 : 0.32),
    ),
  };
}

export const DEFAULT_THEME: ThemeDefinition = {
  id: DEFAULT_THEME_ID,
  label: DEFAULT_THEME_LABEL,
  appearance: "light",
  colors: decodeThemeColors(GITHUB_MONITOR_LIGHT_COLORS),
  variants: {
    dark: decodeThemeColors(GITHUB_MONITOR_DARK_COLORS),
  },
};

/** Theme-file defaults follow this app's palette for the requested mode. */
export function getDefaultThemeColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === "dark" ? DEFAULT_THEME.variants!.dark! : DEFAULT_THEME.colors;
}

const BUILT_IN_THEME_DEFINITIONS: ReadonlyArray<ThemeDefinition> = [DEFAULT_THEME];

export function getThemeDefinition(theme: ThemePreference): ThemeDefinition | null {
  const themeId = themeIdFromPreference(theme);
  return (
    BUILT_IN_THEME_DEFINITIONS.find((definition) => definition.id === themeId) ??
    getCustomThemes().find((definition) => definition.id === themeId) ??
    null
  );
}

export function getThemeColorsForMode(
  theme: ThemeDefinition,
  mode: ThemeAppearance,
): ThemeColors | null {
  if (mode === theme.appearance) return theme.colors;
  return theme.variants?.[mode] ?? null;
}

export function getThemeModes(theme: ThemeDefinition): ReadonlyArray<ThemeAppearance> {
  return (["light", "dark"] as const).filter((mode) => getThemeColorsForMode(theme, mode) !== null);
}

export function getThemePreferenceMode(theme: ThemePreference): ThemeAppearance | null {
  if (theme === "system") return null;
  if (theme === "light" || theme === "dark") return theme;
  return getThemeDefinition(theme)?.appearance ?? null;
}

export function themeIdFromName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "custom-theme";
}

export class ThemeLibraryStorageError extends Error {
  readonly storageKey: string;
  readonly operation: "read" | "write";
  readonly reason: "malformed" | "storage-unavailable";
  readonly cause?: unknown;

  constructor(args: {
    storageKey: string;
    operation: "read" | "write";
    reason: "malformed" | "storage-unavailable";
    cause?: unknown;
  }) {
    const direction = args.operation === "read" ? "from" : "to";
    super(`Failed to ${args.operation} the theme library ${direction} ${args.storageKey}.`);
    this.name = "ThemeLibraryStorageError";
    this.storageKey = args.storageKey;
    this.operation = args.operation;
    this.reason = args.reason;
    this.cause = args.cause;
  }
}

export function isThemeLibraryStorageError(error: unknown): error is ThemeLibraryStorageError {
  return error instanceof ThemeLibraryStorageError;
}

function saveCustomThemes(
  storedThemes: ReadonlyArray<unknown>,
  themes: ReadonlyArray<ThemeDefinition>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(storedThemes));
    customThemeLibrarySnapshot = { status: "ready", storedThemes, themes };
  } catch (cause) {
    throw new ThemeLibraryStorageError({
      storageKey: CUSTOM_THEMES_STORAGE_KEY,
      operation: "write",
      reason: "storage-unavailable",
      cause,
    });
  }
  notifyCustomThemeListeners();
}

function requireWritableCustomThemeLibrary(
  snapshot: CustomThemeLibrarySnapshot,
): Extract<CustomThemeLibrarySnapshot, { status: "ready" }> {
  if (snapshot.status === "unavailable") {
    throw new ThemeLibraryStorageError({
      storageKey: CUSTOM_THEMES_STORAGE_KEY,
      operation: "read",
      reason: snapshot.reason,
      ...("cause" in snapshot ? { cause: snapshot.cause } : {}),
    });
  }
  return snapshot;
}

function getWritableCustomThemeLibrary(): Extract<CustomThemeLibrarySnapshot, { status: "ready" }> {
  return requireWritableCustomThemeLibrary(getCustomThemeLibrarySnapshot());
}

function readWritableCustomThemeLibrary(): Extract<
  CustomThemeLibrarySnapshot,
  { status: "ready" }
> {
  return requireWritableCustomThemeLibrary(readCustomThemeLibrarySnapshot());
}

function storedThemeHasId(storedTheme: unknown, themeId: string): boolean {
  return isRecord(storedTheme) && storedTheme.id === themeId;
}

function storedThemeHasCollectionId(storedTheme: unknown, collectionId: string): boolean {
  return (
    isRecord(storedTheme) &&
    isRecord(storedTheme.collection) &&
    storedTheme.collection.id === collectionId
  );
}

export function installCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) {
    throw new Error(`The theme id "${theme.id}" is reserved.`);
  }
  const library = getWritableCustomThemeLibrary();
  if (
    BUILT_IN_THEME_DEFINITIONS.some((existing) => existing.id === theme.id) ||
    library.storedThemes.some((storedTheme) => storedThemeHasId(storedTheme, theme.id))
  ) {
    throw new Error(`A theme named "${theme.label}" is already installed.`);
  }
  const canonicalTheme = canonicalizeThemeDefinition(theme);
  const themes = [...library.themes, canonicalTheme];
  saveCustomThemes([...library.storedThemes, canonicalTheme], themes);
  return canonicalTheme;
}

export function updateCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) {
    throw new Error(`The theme id "${theme.id}" is reserved.`);
  }

  const library = getWritableCustomThemeLibrary();
  const themes = library.themes;
  const themeIndex = themes.findIndex((existing) => existing.id === theme.id);
  if (themeIndex === -1) {
    throw new Error(`The theme "${theme.label}" is not installed.`);
  }

  const canonicalTheme = canonicalizeThemeDefinition(theme);
  const nextThemes = [...themes];
  nextThemes[themeIndex] = canonicalTheme;

  const nextStoredThemes: unknown[] = [];
  let replaced = false;
  for (const storedTheme of library.storedThemes) {
    if (!storedThemeHasId(storedTheme, theme.id)) {
      nextStoredThemes.push(storedTheme);
    } else if (!replaced) {
      nextStoredThemes.push(canonicalTheme);
      replaced = true;
    }
  }
  saveCustomThemes(nextStoredThemes, nextThemes);
  return canonicalTheme;
}

export function replaceCustomThemeCollection(
  collectionId: string,
  themes: ReadonlyArray<ThemeDefinition>,
  options?: { expectedCollection?: ReadonlyArray<ThemeDefinition> },
): ReadonlyArray<ThemeDefinition> {
  if (themes.length === 0) throw new Error("A theme collection cannot be empty.");

  const validated = themes.map((theme) => parseStoredTheme(theme));
  if (
    validated.some((theme) => theme === null || theme.collection?.id !== collectionId) ||
    new Set(validated.map((theme) => theme?.id)).size !== validated.length
  ) {
    throw new Error("That theme collection is invalid.");
  }
  const replacement = validated as ThemeDefinition[];
  const library = readWritableCustomThemeLibrary();
  const current = library.themes;
  const currentCollection = current.filter((theme) => theme.collection?.id === collectionId);
  if (
    options?.expectedCollection &&
    JSON.stringify(currentCollection) !== JSON.stringify(options.expectedCollection)
  ) {
    throw new Error("Your installed themes changed while this package was downloading. Try again.");
  }
  const occupiedIds = new Set(BUILT_IN_THEME_DEFINITIONS.map((theme) => theme.id));
  for (const storedTheme of library.storedThemes) {
    if (
      !storedThemeHasCollectionId(storedTheme, collectionId) &&
      isRecord(storedTheme) &&
      typeof storedTheme.id === "string"
    ) {
      occupiedIds.add(storedTheme.id);
    }
  }
  const conflictingTheme = replacement.find(
    (theme) => RESERVED_THEME_IDS.has(theme.id) || occupiedIds.has(theme.id),
  );
  if (conflictingTheme) {
    throw new Error(`A theme named "${conflictingTheme.label}" is already installed.`);
  }

  const nextStoredThemes: unknown[] = [];
  let insertedReplacement = false;
  for (const storedTheme of library.storedThemes) {
    if (!storedThemeHasCollectionId(storedTheme, collectionId)) {
      nextStoredThemes.push(storedTheme);
    } else if (!insertedReplacement) {
      nextStoredThemes.push(...replacement);
      insertedReplacement = true;
    }
  }
  if (!insertedReplacement) nextStoredThemes.push(...replacement);

  saveCustomThemes(nextStoredThemes, parseStoredThemes(nextStoredThemes));
  return replacement;
}

export function removeCustomTheme(themeId: string): void {
  removeCustomThemes([themeId]);
}

export function removeCustomThemes(themeIds: ReadonlyArray<string>): void {
  const removedIds = new Set(themeIds);
  if (removedIds.size === 0) return;
  const library = getWritableCustomThemeLibrary();
  const nextThemes = library.themes.filter((theme) => !removedIds.has(theme.id));
  if (nextThemes.length === library.themes.length) return;
  saveCustomThemes(
    library.storedThemes.filter(
      (storedTheme) =>
        !isRecord(storedTheme) ||
        typeof storedTheme.id !== "string" ||
        !removedIds.has(storedTheme.id),
    ),
    nextThemes,
  );
}

function parseThemeColorOverrides(value: unknown): ThemeColorOverrides {
  if (!isRecord(value)) throw new Error("Theme colors must be objects.");

  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    if (!THEME_COLOR_ROLE_SET.has(role)) {
      throw new Error(`"${role}" is not a supported theme color role.`);
    }
    const normalized = toCanonicalThemeColor(color);
    if (!normalized) {
      throw new Error(
        `The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`,
      );
    }
    overrides[role as ThemeColorRole] = normalized;
  }
  if (Object.keys(overrides).length === 0) {
    throw new Error("Add at least one color role to the theme file.");
  }
  return overrides;
}

export function parseThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) {
    throw new Error("Theme files must contain a JSON object.");
  }
  if (value.version !== THEME_FILE_VERSION) {
    throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`);
  }

  const name = value.name;
  const appearance = value.appearance;
  const rawColors = value.colors;
  if (!isThemeLabel(name)) throw new Error("Theme files need a name (48 characters or fewer).");
  if (!isThemeAppearance(appearance)) {
    throw new Error('Theme files need an appearance of "light" or "dark".');
  }
  if (!isRecord(rawColors)) throw new Error("Theme files need a colors object.");

  const id = value.id === undefined ? themeIdFromName(name) : value.id;
  if (!isThemeId(id)) {
    throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  }
  if (RESERVED_THEME_IDS.has(id)) {
    throw new Error(`The theme id "${id}" is reserved.`);
  }

  const overrides = parseThemeColorOverrides(rawColors);
  const collection = parseThemeCollection(value.collection);
  if (value.collection !== undefined && !collection) {
    throw new Error("Theme collections need a valid id and label.");
  }

  const fallback = getDefaultThemeColors(appearance);
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");
    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) {
        throw new Error('Theme variants may only be named "light" or "dark".');
      }
      if (variantAppearance === appearance) {
        throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`);
      }
      const variantFallback = getDefaultThemeColors(variantAppearance);
      variants[variantAppearance] = {
        ...variantFallback,
        ...parseThemeColorOverrides(variantColors),
      };
    }
  }

  return {
    id,
    label: name.trim(),
    appearance,
    colors: { ...fallback, ...overrides },
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

export function serializeThemeFile(theme: ThemeDefinition): string {
  const canonicalTheme = canonicalizeThemeDefinition(theme);
  const file: ThemeFile = {
    version: THEME_FILE_VERSION,
    id: canonicalTheme.id,
    name: canonicalTheme.label,
    appearance: canonicalTheme.appearance,
    colors: canonicalTheme.colors,
    ...(canonicalTheme.variants ? { variants: canonicalTheme.variants } : {}),
    ...(canonicalTheme.collection ? { collection: canonicalTheme.collection } : {}),
    ...(canonicalTheme.managed ? { managed: true } : {}),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

const APP_THEME_VARIABLES: Readonly<Record<ThemeColorRole, string>> = {
  canvas: "--app-theme-canvas",
  chrome: "--app-theme-chrome",
  toolbar: "--app-theme-toolbar",
  toolbarForeground: "--app-theme-toolbar-foreground",
  toolbarBorder: "--app-theme-toolbar-border",
  toolbarControl: "--app-theme-toolbar-control",
  toolbarControlForeground: "--app-theme-toolbar-control-foreground",
  toolbarControlHover: "--app-theme-toolbar-control-hover",
  surface: "--app-theme-surface",
  surfaceRaised: "--app-theme-surface-raised",
  surfaceOverlay: "--app-theme-surface-overlay",
  text: "--app-theme-text",
  textMuted: "--app-theme-text-muted",
  border: "--app-theme-border",
  input: "--app-theme-input",
  focus: "--app-theme-focus",
  accent: "--app-theme-accent",
  accentForeground: "--app-theme-accent-foreground",
  secondary: "--app-theme-secondary",
  secondaryForeground: "--app-theme-secondary-foreground",
  muted: "--app-theme-muted",
  mutedForeground: "--app-theme-muted-foreground",
  placeholder: "--app-theme-placeholder",
  secondaryLabel: "--app-theme-secondary-label",
  iconMuted: "--app-theme-icon-muted",
  error: "--app-theme-error",
  errorForeground: "--app-theme-error-foreground",
  errorSurface: "--app-theme-error-surface",
  warning: "--app-theme-warning",
  warningForeground: "--app-theme-warning-foreground",
  warningSurface: "--app-theme-warning-surface",
  update: "--app-theme-update",
  updateForeground: "--app-theme-update-foreground",
  updateSurface: "--app-theme-update-surface",
  accentSurface: "--app-theme-accent-surface",
  accentSurfaceForeground: "--app-theme-accent-surface-foreground",
  messageSurface: "--app-theme-message-surface",
  messageForeground: "--app-theme-message-foreground",
  messageAction: "--app-theme-message-action",
  messageActionForeground: "--app-theme-message-action-foreground",
  messageActionHover: "--app-theme-message-action-hover",
  codeBackground: "--app-theme-code-background",
  codeForeground: "--app-theme-code-foreground",
  sidebar: "--app-theme-sidebar",
  sidebarForeground: "--app-theme-sidebar-foreground",
  sidebarMutedForeground: "--app-theme-sidebar-muted-foreground",
  sidebarControlSurface: "--app-theme-sidebar-control-surface",
  sidebarRowHover: "--app-theme-sidebar-row-hover",
  sidebarRowActive: "--app-theme-sidebar-row-active",
  sidebarRowSelected: "--app-theme-sidebar-row-selected",
  sidebarBorder: "--app-theme-sidebar-border",
  terminalBackground: "--app-theme-terminal-background",
  terminalForeground: "--app-theme-terminal-foreground",
  terminalCursor: "--app-theme-terminal-cursor",
  terminalSelection: "--app-theme-terminal-selection-background",
  terminalScrollbar: "--app-theme-terminal-scrollbar",
  terminalScrollbarHover: "--app-theme-terminal-scrollbar-hover",
};

export function getThemeColorVariable(role: ThemeColorRole): string {
  return APP_THEME_VARIABLES[role];
}

const GITHUB_MONITOR_TOKEN_VARS = [
  "--page-plane",
  "--surface-1",
  "--sidebar",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--gridline",
  "--baseline",
  "--border",
  "--border-strong",
  "--wash",
  "--wash-strong",
  "--accent",
  "--accent-ink",
  "--delta-down",
  "--status-critical",
  "--status-warning",
  "--status-serious",
  "--delta-up",
  "--status-good",
] as const;

function applyGithubMonitorTokens(
  root: HTMLElement,
  colors: ThemeColors,
  appearance: ThemeAppearance,
): void {
  root.style.setProperty("--page-plane", colors.canvas);
  root.style.setProperty("--surface-1", colors.surface);
  root.style.setProperty("--sidebar", colors.sidebar);
  root.style.setProperty("--text-primary", colors.text);
  root.style.setProperty("--text-secondary", colors.mutedForeground);
  root.style.setProperty("--text-muted", colors.textMuted);
  root.style.setProperty("--gridline", colors.border);
  root.style.setProperty("--baseline", colors.input);
  root.style.setProperty("--border", colors.border);
  root.style.setProperty("--border-strong", colors.sidebarBorder);
  root.style.setProperty("--wash", colors.muted);
  root.style.setProperty("--wash-strong", colors.sidebarRowHover);
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--accent-ink", colors.accentForeground);
  root.style.setProperty("--delta-down", colors.error);
  root.style.setProperty("--status-critical", colors.error);
  root.style.setProperty("--status-warning", colors.warning);
  root.style.setProperty("--status-serious", colors.warning);
  root.style.setProperty("--delta-up", appearance === "dark" ? "#0ca30c" : "#006300");
  root.style.setProperty("--status-good", "#0ca30c");
}

function clearAppliedTheme(root: HTMLElement, appearance: ThemeAppearance): void {
  delete root.dataset.themeId;
  if (appearance === "light" || appearance === "dark") {
    root.setAttribute("data-theme", appearance);
  }
  root.style.colorScheme = appearance;
  for (const variable of Object.values(APP_THEME_VARIABLES)) {
    root.style.removeProperty(variable);
  }
  for (const token of GITHUB_MONITOR_TOKEN_VARS) {
    root.style.removeProperty(token);
  }
}

export function applyThemePalette(theme: ThemePreference, appearance?: ThemeAppearance): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  if (!root?.style) return;

  const palette = getThemeDefinition(theme) ?? DEFAULT_THEME;
  const mode = appearance ?? palette.appearance;
  if (palette.id === DEFAULT_THEME_ID) {
    // Built-in tokens live in CSS so Default matches the validated palettes
    // exactly, including before JS runs.
    clearAppliedTheme(root, mode);
    return;
  }

  const colors = getThemeColorsForMode(palette, mode) ?? palette.colors;
  root.dataset.themeId = palette.id;
  root.setAttribute("data-theme", mode);
  root.style.colorScheme = mode;
  for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
    root.style.setProperty(APP_THEME_VARIABLES[role], value);
  }
  applyGithubMonitorTokens(root, colors, mode);
}

export function resolveThemeAppearance(
  themeId: ThemePreference,
  appearanceMode: ThemePreferenceMode,
  systemDark: boolean,
): ThemeAppearance {
  const requested = appearanceMode === "system" ? (systemDark ? "dark" : "light") : appearanceMode;
  const definition = getThemeDefinition(themeId) ?? DEFAULT_THEME;
  return getThemeColorsForMode(definition, requested) === null ? definition.appearance : requested;
}

export function applyDocumentTheme(
  themeId: ThemePreference,
  appearanceMode: ThemePreferenceMode,
  systemDark: boolean,
): ThemeAppearance {
  const appearance = resolveThemeAppearance(themeId, appearanceMode, systemDark);
  applyThemePalette(themeId, appearance);
  return appearance;
}

export function isKnownThemePreference(theme: string): boolean {
  if (theme === "light" || theme === "dark" || theme === "system") return true;
  return getThemeDefinition(theme) !== null;
}
