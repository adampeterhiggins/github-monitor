import { useMemo, useState } from "react";
import { useApp } from "../lib/state/app";
import { useSavedFilters } from "../lib/state/savedFilters";
import type { SavedFilter, SavedFilterKind } from "../lib/db/queries";
import { Button, Callout, Card, CardHeader, DataTable, full } from "./ui";

/**
 * Managing saved selections: rename, replace with what is currently selected,
 * apply, and delete.
 *
 * Repository selections are stored as ids, so this is also where a selection that
 * has gone stale becomes visible — ids whose repositories no longer exist are
 * counted and can be pruned, rather than silently shrinking the selection every
 * time it is applied.
 */
export function SavedSelectionsPanel() {
  const { filters, remove, rename, updateValues, save } = useSavedFilters();
  const repos = useApp((s) => s.repos);
  const selectedRepoIds = useApp((s) => s.selectedRepoIds);
  const setSelectedRepos = useApp((s) => s.setSelectedRepos);
  const selectedLogins = useApp((s) => s.selectedLogins);
  const setSelectedLogins = useApp((s) => s.setSelectedLogins);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<SavedFilterKind>("repos");
  const [notice, setNotice] = useState<string | null>(null);

  const knownRepoIds = useMemo(() => new Set(repos.map((r) => r.id)), [repos]);

  const missingFor = (f: SavedFilter) =>
    f.kind === "repos" ? f.values.filter((v) => !knownRepoIds.has(Number(v))).length : 0;

  const applyFilter = (f: SavedFilter) => {
    if (f.kind === "repos") {
      const ids = f.values.map(Number).filter((id) => knownRepoIds.has(id));
      void setSelectedRepos(ids);
      setNotice(
        `Applied “${f.name}” — ${full(ids.length)} repositories` +
          (missingFor(f) > 0 ? `, ${full(missingFor(f))} no longer exist and were skipped.` : "."),
      );
    } else {
      setSelectedLogins(f.values.map(String));
      setNotice(`Applied “${f.name}” — ${full(f.values.length)} contributors.`);
    }
  };

  const replaceWithCurrent = async (f: SavedFilter) => {
    const values = f.kind === "repos" ? selectedRepoIds : selectedLogins;
    await updateValues(f.id, values);
    setNotice(`“${f.name}” now holds the current selection (${full(values.length)}).`);
  };

  const createFromCurrent = async () => {
    const values = newKind === "repos" ? selectedRepoIds : selectedLogins;
    if (!newName.trim()) return;
    await save(newKind, newName, values);
    setNotice(`Saved “${newName.trim()}” with ${full(values.length)} entries.`);
    setNewName("");
  };

  return (
    <Card>
      <CardHeader
        title="Saved selections"
        subtitle="Named groups of repositories or contributors, applied from here or from the filter dropdowns"
      />

      {notice ? (
        <div className="mb-3">
          <Callout>{notice}</Callout>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-end gap-2 border-b border-hairline pb-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-ink-secondary">Save the current</label>
          <div className="flex items-center gap-1.5">
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as SavedFilterKind)}
              className="h-7 rounded-md border border-hairline-strong bg-surface px-1.5 text-[12px] text-ink"
            >
              <option value="repos">
                repository selection ({full(selectedRepoIds.length)})
              </option>
              <option value="contributors">
                contributor selection ({full(selectedLogins.length)})
              </option>
            </select>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createFromCurrent();
              }}
              placeholder="Name it…"
              className="h-7 w-48 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink placeholder:text-ink-muted focus:outline-2 focus:outline-offset-0 focus:outline-accent"
            />
            <Button variant="primary" onClick={() => void createFromCurrent()} disabled={!newName.trim()}>
              Save
            </Button>
          </div>
        </div>
      </div>

      <DataTable
        rows={filters}
        maxHeight={340}
        empty="Nothing saved yet. Save a selection here, or from the Repositories / Contributors dropdowns on any page."
        rowKey={(f) => f.id}
        columns={[
          {
            key: "name",
            header: "Name",
            render: (f) =>
              editingId === f.id ? (
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void rename(f.id, draftName).then(() => setEditingId(null));
                    }
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="h-6 w-40 rounded border border-hairline-strong bg-surface px-1.5 text-[12px] text-ink"
                />
              ) : (
                <button
                  className="text-left text-ink hover:underline"
                  title="Rename"
                  onClick={() => {
                    setEditingId(f.id);
                    setDraftName(f.name);
                  }}
                >
                  {f.name}
                </button>
              ),
            sortValue: (f) => f.name,
          },
          {
            key: "kind",
            header: "Kind",
            render: (f) => (f.kind === "repos" ? "Repositories" : "Contributors"),
            sortValue: (f) => f.kind,
          },
          {
            key: "count",
            header: "Entries",
            align: "right",
            render: (f) => {
              const missing = missingFor(f);
              return (
                <span title={missing > 0 ? `${full(missing)} no longer exist` : undefined}>
                  {full(f.values.length)}
                  {missing > 0 ? (
                    <span style={{ color: "var(--status-warning)" }}> ◆ {full(missing)} stale</span>
                  ) : null}
                </span>
              );
            },
            sortValue: (f) => f.values.length,
          },
          {
            key: "updated",
            header: "Updated",
            align: "right",
            render: (f) =>
              f.updated_at ? new Date(f.updated_at).toLocaleDateString("en-GB") : "—",
            sortValue: (f) => f.updated_at ?? "",
          },
          {
            key: "actions",
            header: "",
            align: "right",
            width: "230px",
            render: (f) => (
              <span className="flex items-center justify-end gap-1">
                {editingId === f.id ? (
                  <>
                    <Button
                      variant="primary"
                      onClick={() => void rename(f.id, draftName).then(() => setEditingId(null))}
                    >
                      Save name
                    </Button>
                    <Button variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button onClick={() => applyFilter(f)}>Apply</Button>
                    <Button
                      variant="ghost"
                      title="Overwrite with whatever is selected right now"
                      onClick={() => void replaceWithCurrent(f)}
                    >
                      Update
                    </Button>
                    <Button variant="danger" onClick={() => void remove(f.id)}>
                      Delete
                    </Button>
                  </>
                )}
              </span>
            ),
          },
        ]}
      />

      <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
        Repository selections store ids, so one that references a repository which has
        since been deleted or left the organisation shows as <strong>stale</strong> and those
        entries are skipped when applied. Contributor selections store logins and are unaffected.
        Saved selections live in the database and survive clearing the cache.
      </p>
    </Card>
  );
}
