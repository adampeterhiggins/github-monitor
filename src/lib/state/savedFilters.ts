import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApp } from "./app";
import {
  deleteSavedFilter,
  listSavedFilters,
  renameSavedFilter,
  saveFilter,
  updateSavedFilterValues,
  type SavedFilter,
  type SavedFilterKind,
} from "../db/queries";

/**
 * Named selections of repositories or contributors.
 *
 * Shared between the two filter dropdowns and the Settings manager, so saving in
 * one place shows up immediately in the other.
 */
export interface SavedFiltersController {
  filters: SavedFilter[];
  loading: boolean;
  save: (kind: SavedFilterKind, name: string, values: Array<number | string>) => Promise<void>;
  rename: (id: number, name: string) => Promise<void>;
  updateValues: (id: number, values: Array<number | string>) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

export function useSavedFilters(kind?: SavedFilterKind): SavedFiltersController {
  const db = useApp((s) => s.db);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["saved-filters", kind ?? "all"],
    enabled: db != null,
    queryFn: () => listSavedFilters(db!, kind),
    staleTime: 30_000,
  });

  // Every list of saved filters is invalidated after a write, not just this one:
  // the dropdown asks for one kind and Settings asks for all, and they must not
  // disagree about what exists.
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["saved-filters"] }),
    [queryClient],
  );

  return {
    filters: query.data ?? [],
    loading: query.isLoading,
    save: useCallback(
      async (k, name, values) => {
        if (!db) return;
        await saveFilter(db, k, name, values);
        await invalidate();
      },
      [db, invalidate],
    ),
    rename: useCallback(
      async (id, name) => {
        if (!db) return;
        await renameSavedFilter(db, id, name);
        await invalidate();
      },
      [db, invalidate],
    ),
    updateValues: useCallback(
      async (id, values) => {
        if (!db) return;
        await updateSavedFilterValues(db, id, values);
        await invalidate();
      },
      [db, invalidate],
    ),
    remove: useCallback(
      async (id) => {
        if (!db) return;
        await deleteSavedFilter(db, id);
        await invalidate();
      },
      [db, invalidate],
    ),
  };
}

/**
 * A small inline "save as…" helper shared by both dropdowns.
 *
 * Returns a suggested name that does not collide with an existing one, so
 * repeatedly saving does not silently overwrite the previous attempt.
 */
export function suggestName(existing: SavedFilter[], base: string): string {
  const taken = new Set(existing.map((f) => f.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}
