import { useEffect, useState } from "react";
import { useApp } from "../state/app";
import { paletteFor, type VizMode, type VizPalette } from "./palette";

/**
 * Charts need literal color strings, so they cannot read CSS custom properties
 * the way the rest of the UI does. This resolves the user's theme choice — which
 * may be "system" — to a concrete mode and re-renders when the OS setting flips.
 *
 * Dark is a *selected* palette, not a lightness flip of the light one; see
 * palette.ts.
 */
export function useVizMode(): VizMode {
  const theme = useApp((s) => s.theme);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  if (theme === "light") return "light";
  if (theme === "dark") return "dark";
  return systemDark ? "dark" : "light";
}

export function useVizPalette(): VizPalette {
  return paletteFor(useVizMode());
}
