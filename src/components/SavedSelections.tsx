import { useState } from "react";
import { useSavedFilters, suggestName } from "../lib/state/savedFilters";
import type { SavedFilterKind } from "../lib/db/queries";
import { Button, full } from "./ui";

/**
 * The saved-selections strip inside a filter dropdown: apply one, or save what is
 * currently selected.
 *
 * Naming happens inline rather than in a modal — a dropdown that spawns a dialog
 * has to close first, which loses the very selection you are trying to save.
 */
export function SavedSelections({
  kind,
  currentValues,
  onApply,
  /** Describes the current selection, used to suggest a name. */
  suggested,
}: {
  kind: SavedFilterKind;
  currentValues: Array<number | string>;
  onApply: (values: Array<number | string>) => void;
  suggested: string;
}) {
  const { filters, save, remove } = useSavedFilters(kind);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const startNaming = () => {
    setName(suggestName(filters, suggested));
    setError(null);
    setNaming(true);
  };

  const commit = async () => {
    try {
      await save(kind, name, currentValues);
      setNaming(false);
      setError(null);
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    }
  };

  const existing = filters.find((f) => f.name.toLowerCase() === name.trim().toLowerCase());

  return (
    <div className="border-b border-hairline px-2 py-1.5">
      {filters.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap items-center gap-1">
          <span className="mr-0.5 text-[10px] uppercase tracking-wide text-ink-muted">Saved</span>
          {filters.map((f) => (
            <span key={f.id} className="group inline-flex items-center">
              <button
                onClick={() => onApply(f.values)}
                title={`Apply “${f.name}” — ${full(f.values.length)} ${
                  kind === "repos" ? "repositories" : "contributors"
                }`}
                className="rounded-l-md border border-hairline-strong px-1.5 py-0.5 text-[11px] text-ink hover:bg-wash"
              >
                {f.name}
                <span className="ml-1 tabular text-ink-muted">{full(f.values.length)}</span>
              </button>
              <button
                onClick={() => void remove(f.id)}
                title={`Delete “${f.name}”`}
                aria-label={`Delete ${f.name}`}
                className="rounded-r-md border border-l-0 border-hairline-strong px-1 py-0.5 text-[11px] text-ink-muted hover:bg-wash hover:text-critical"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {naming ? (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") setNaming(false);
            }}
            placeholder="Name this selection"
            className="h-6 min-w-0 flex-1 rounded border border-hairline-strong bg-surface px-1.5 text-[11px] text-ink focus:outline-2 focus:outline-offset-0 focus:outline-accent"
          />
          <Button variant="primary" onClick={() => void commit()} disabled={!name.trim()}>
            {existing ? "Replace" : "Save"}
          </Button>
          <Button variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          onClick={startNaming}
          disabled={currentValues.length === 0}
          title={
            currentValues.length === 0
              ? "Select something first"
              : `Save these ${full(currentValues.length)} as a named selection`
          }
        >
          Save current selection…
        </Button>
      )}

      {error ? <p className="mt-1 text-[10px] text-critical">{error}</p> : null}
      {naming && existing ? (
        <p className="mt-1 text-[10px] text-ink-secondary">
          “{existing.name}” already exists and will be replaced.
        </p>
      ) : null}
    </div>
  );
}
