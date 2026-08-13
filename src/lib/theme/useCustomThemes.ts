import { useSyncExternalStore } from "react";
import { getCustomThemes, subscribeToCustomThemes } from "./palette";

const EMPTY: readonly [] = [];

export function useCustomThemes() {
  return useSyncExternalStore(subscribeToCustomThemes, getCustomThemes, () => EMPTY);
}
