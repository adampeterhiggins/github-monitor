#!/usr/bin/env node
/**
 * Theme import tests.
 *
 *   npm run test:themes
 *
 * Bundles the VS Code converter and palette engine with esbuild and runs them
 * in Node. No Tauri runtime: culori and the color math are plain JS.
 */

import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const work = mkdtempSync(join(tmpdir(), "gm-theme-"));

async function bundle(entry, out) {
  const file = join(work, out);
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: file,
    logLevel: "error",
  });
  return require(file);
}

const palette = await bundle("src/lib/theme/palette.ts", "palette.cjs");
const vscode = await bundle("src/lib/theme/vscodeImport.ts", "vscode.cjs");

const {
  getThemeColorsForMode,
  themeColorToHex,
  THEME_FILE_VERSION,
  parseThemeFile,
  DEFAULT_THEME_ID,
} = palette;
const {
  isVsCodeThemeFile,
  pairVsCodeThemes,
  parseVsCodeThemeFile,
  resolveThemeLabelCollisions,
} = vscode;

let failures = 0;
const T = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

function asHex(value) {
  const hex = themeColorToHex(value);
  if (!hex) throw new Error(`Expected a theme color, received ${value}`);
  return hex;
}

function contrastRatio(first, second) {
  const toChannels = (value) => {
    const hex = asHex(value).slice(1);
    return [0, 1, 2].map(
      (channel) => Number.parseInt(hex.slice(channel * 2, channel * 2 + 2), 16) / 255,
    );
  };
  const luminance = (value) =>
    toChannels(value)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

const VSCODE_DARK = {
  name: "pierre-dark-soft",
  type: "dark",
  colors: {
    "editor.background": "#171717",
    "editor.foreground": "#d4d4d4",
    foreground: "#d4d4d4",
    "sideBar.background": "#101010",
    "sideBar.foreground": "#8a8a8a",
    "sideBar.border": "#1d1d1d",
    focusBorder: "#69b1ff",
    "button.background": "#69b1ff",
    "button.foreground": "#171717",
    "input.border": "#2c2c2c",
    "input.placeholderForeground": "#525252",
    "terminal.background": "#101010",
    "terminal.foreground": "#8a8a8a",
    "list.hoverBackground": "#1f3e5e59",
    "list.activeSelectionBackground": "#1f3e5e99",
  },
  tokenColors: [],
};

{
  T("recognises a workbench theme", isVsCodeThemeFile(VSCODE_DARK) === true);
  T("recognises tokenColors-only as a VS Code theme", isVsCodeThemeFile({ type: "dark", tokenColors: [] }) === true);
  T(
    "rejects our own theme files",
    isVsCodeThemeFile({
      version: THEME_FILE_VERSION,
      name: "Aurora",
      appearance: "light",
      colors: { canvas: "#ffffff" },
    }) === false,
  );
  T("rejects non-objects", isVsCodeThemeFile("nope") === false);
}

{
  const theme = parseVsCodeThemeFile(VSCODE_DARK);
  T("humanizes the slug name", theme.label === "Pierre Dark Soft");
  T("reads dark appearance", theme.appearance === "dark");
  T("carries editor background", asHex(theme.colors.canvas) === "#171717");
  T("carries editor foreground", asHex(theme.colors.text) === "#d4d4d4");
  T("carries accent", asHex(theme.colors.accent) === "#69b1ff");
  T("carries sidebar", asHex(theme.colors.sidebar) === "#101010");
  T("carries terminal", asHex(theme.colors.terminalBackground) === "#101010");
}

{
  const theme = parseVsCodeThemeFile(VSCODE_DARK);
  T("flattens alpha overlays to opaque oklch", /^oklch\(/.test(theme.colors.sidebarRowHover));
  T("does not keep the 8-digit hover hex", asHex(theme.colors.sidebarRowHover) !== "#1f3e5e59");
  T("selected row differs from sidebar", theme.colors.sidebarRowSelected !== theme.colors.sidebar);
}

{
  const theme = parseVsCodeThemeFile(VSCODE_DARK);
  const colors = getThemeColorsForMode(theme, "dark");
  const everyOklch = Object.values(colors).every((value) => /^oklch\(/.test(value));
  T("fills omitted roles as oklch", everyOklch);
  T("text is readable on canvas", contrastRatio(colors.text, colors.canvas) >= 4.5);
  T(
    "sidebar text is readable",
    contrastRatio(colors.sidebarForeground, colors.sidebar) >= 4.5,
  );
  T(
    "action text is readable",
    contrastRatio(colors.messageActionForeground, colors.messageAction) >= 4.5,
  );
}

{
  const untyped = parseVsCodeThemeFile({
    name: "Untyped",
    colors: { "editor.background": "#fdfdfd", "editor.foreground": "#202020" },
  });
  T("untyped light canvas is light", untyped.appearance === "light");
  const hc = parseVsCodeThemeFile({
    name: "High contrast",
    type: "hc-light",
    colors: { "editor.background": "#ffffff" },
  });
  T("hc-light is light", hc.appearance === "light");
}

{
  const theme = parseVsCodeThemeFile({
    name: "Unreadable",
    type: "dark",
    colors: { "editor.background": "#101010", "editor.foreground": "#111111" },
  });
  T("drops an unreadable foreground", asHex(theme.colors.text) !== "#111111");
  T("replacement text is readable", contrastRatio(theme.colors.text, theme.colors.canvas) >= 4.5);
}

{
  const theme = parseVsCodeThemeFile({
    name: "Split",
    type: "dark",
    colors: {
      "editor.background": "#101010",
      "editor.foreground": "#f5f5f5",
      "sideBar.background": "#fafafa",
      "terminal.background": "#fbfbfb",
    },
  });
  T("keeps a light sidebar on a dark theme", asHex(theme.colors.sidebar) === "#fafafa");
  T(
    "sidebar foreground follows the replaced surface",
    contrastRatio(theme.colors.sidebarForeground, theme.colors.sidebar) >= 4.5,
  );
  T(
    "terminal foreground follows the replaced surface",
    contrastRatio(theme.colors.terminalForeground, theme.colors.terminalBackground) >= 4.5,
  );
}

{
  const theme = parseVsCodeThemeFile({
    name: "Vibrant",
    type: "dark",
    colors: {
      "editor.background": "color(display-p3 0.039216 0.039216 0.039216)",
      "editor.foreground": "color(display-p3 0.980392 0.980392 0.980392)",
      focusBorder: "color(display-p3 0.308664 0.645271 1.000000)",
      "editor.selectionBackground": "color(display-p3 0.308664 0.645271 1.000000 / 0.300000)",
    },
  });
  T("reads P3 canvas as near-black", /^#0[89ab]/.test(asHex(theme.colors.canvas)));
  T("reads P3 text as near-white", /^#f[a-f0-9]/.test(asHex(theme.colors.text)));
  const accent = asHex(theme.colors.accent);
  const [red, green, blue] = [1, 3, 5].map((index) =>
    Number.parseInt(accent.slice(index, index + 2), 16),
  );
  T("P3 accent stays blue", blue > 200 && blue > red && green > red);
}

{
  const make = (name, type) =>
    parseVsCodeThemeFile({
      name,
      type,
      colors: {
        "editor.background": type === "dark" ? "#101014" : "#fdfdfd",
        "editor.foreground": type === "dark" ? "#e6e6e6" : "#1f1f1f",
        focusBorder: "#69b1ff",
      },
    });
  const themes = pairVsCodeThemes([
    make("github-dark", "dark"),
    make("github-light", "light"),
    make("github-dark-colorblind", "dark"),
    make("github-light-colorblind", "light"),
    make("github-dark-dimmed", "dark"),
  ]);
  T(
    "pairs light/dark families",
    JSON.stringify(themes.map((theme) => theme.label)) ===
      JSON.stringify(["Github", "Github Colorblind", "Github Dark Dimmed"]),
  );
  T("paired theme is dual-mode", getThemeColorsForMode(themes[0], "dark") != null);
  T("paired light canvas is light", asHex(themes[0].colors.canvas) === "#fdfdfd");
  T("unpaired dimmed stays single", getThemeColorsForMode(themes[2], "light") == null);
}

{
  const make = (name, type) =>
    parseVsCodeThemeFile({
      name,
      type,
      colors: { "editor.background": type === "dark" ? "#101014" : "#fdfdfd" },
    });
  const themes = pairVsCodeThemes([
    make("solar-dark", "dark"),
    make("solar-dark-soft", "dark"),
    make("solar-light", "light"),
  ]);
  const labels = themes.map((theme) => theme.label).sort();
  T(
    "does not guess an ambiguous family",
    JSON.stringify(labels) === JSON.stringify(["Solar", "Solar Dark Soft"]),
  );
}

{
  const theme = parseVsCodeThemeFile(VSCODE_DARK);
  const spread = (value) => {
    const hex = asHex(value);
    const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
    return Math.max(...channels) - Math.min(...channels);
  };
  T("derived code surface stays neutral", spread(theme.colors.codeBackground) <= 8);
  T("derived surface stays neutral", spread(theme.colors.surface) <= 8);
  T("derived text stays neutral", spread(theme.colors.text) <= 12);
  T("accent keeps the file color", asHex(theme.colors.accent) === "#69b1ff");
}

{
  const dracula = (bg) =>
    parseVsCodeThemeFile({
      name: "Dracula",
      type: "dark",
      colors: { "editor.background": bg, "editor.foreground": "#f8f8f2" },
    });
  const themes = resolveThemeLabelCollisions([
    { theme: dracula("#282a36"), sourceName: "dracula.json" },
    { theme: dracula("#22232e"), sourceName: "dracula-soft.json" },
  ]);
  T(
    "relabels collisions from file names",
    JSON.stringify(themes.map((theme) => theme.label)) ===
      JSON.stringify(["Dracula", "Dracula Soft"]),
  );
  T(
    "collision ids follow the file names",
    JSON.stringify(themes.map((theme) => theme.id)) === JSON.stringify(["dracula", "dracula-soft"]),
  );
  const numbered = resolveThemeLabelCollisions([{ theme: dracula("#282a36") }, { theme: dracula("#22232e") }]);
  T(
    "numbers collisions without file names",
    JSON.stringify(numbered.map((theme) => theme.label)) ===
      JSON.stringify(["Dracula", "Dracula 2"]),
  );
}

{
  const theme = parseVsCodeThemeFile({
    displayName: "---",
    name: "night-owl",
    type: "dark",
    colors: { "editor.background": "#011627" },
  });
  T("falls through an empty displayName", theme.label === "Night Owl");
}

{
  const make = (name, type) =>
    parseVsCodeThemeFile({
      name,
      type,
      colors: { "editor.background": type === "dark" ? "#101014" : "#fdfdfd" },
    });
  const themes = pairVsCodeThemes([
    make("default-light", "light"),
    make("default-dark", "dark"),
  ]);
  T(
    "keeps a reserved stripped name as two themes",
    JSON.stringify(themes.map((theme) => theme.label).sort()) ===
      JSON.stringify(["Default Dark", "Default Light"]),
  );
}

{
  let message = "";
  try {
    parseVsCodeThemeFile({ name: "Empty", type: "dark", colors: {} });
  } catch (cause) {
    message = cause instanceof Error ? cause.message : String(cause);
  }
  T("explains a missing editor.background", /editor\.background/.test(message));
}

{
  let reserved = "";
  try {
    parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Default",
      appearance: "light",
      colors: { canvas: "#ffffff" },
    });
  } catch (cause) {
    reserved = cause instanceof Error ? cause.message : String(cause);
  }
  T("reserves the built-in default id", reserved.includes(DEFAULT_THEME_ID));
}

if (failures > 0) {
  console.error(`\n${failures} theme test(s) failed`);
  process.exit(1);
}
console.log("\nAll theme tests passed");
