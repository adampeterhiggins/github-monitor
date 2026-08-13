import { useCallback, useMemo, useState } from "react";
import {
  DEFAULT_THEME,
  getThemeColorsForMode,
  getThemeModes,
  removeCustomTheme,
  serializeThemeFile,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../lib/theme/palette";
import { useCustomThemes } from "../lib/theme/useCustomThemes";
import { useApp, type ThemeMode } from "../lib/state/app";
import { ThemeImportDialog } from "./ThemeImportDialog";
import { Button, Card, CardHeader, Segmented } from "./ui";

function previewOf(theme: ThemeDefinition, mode: ThemeAppearance) {
  const colors = getThemeColorsForMode(theme, mode) ?? theme.colors;
  return { canvas: colors.canvas, sidebar: colors.sidebar, accent: colors.accent };
}

function ThemeSwatch({
  canvas,
  sidebar,
  accent,
}: {
  canvas: string;
  sidebar: string;
  accent: string;
}) {
  return (
    <span className="relative inline-block h-9 w-14" aria-hidden>
      <span
        className="absolute left-0 top-1 size-7 rounded-full border border-hairline"
        style={{ background: sidebar }}
      />
      <span
        className="absolute left-3.5 top-0 size-7 rounded-full border border-hairline"
        style={{ background: canvas }}
      />
      <span
        className="absolute bottom-0 right-0 size-3 rounded-full border border-hairline"
        style={{ background: accent }}
      />
    </span>
  );
}

function downloadThemeFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function ThemeCard({
  theme,
  active,
  onUse,
  onDownload,
  onRemove,
}: {
  theme: ThemeDefinition;
  active: boolean;
  onUse: () => void;
  onDownload?: () => void;
  onRemove?: () => void;
}) {
  const modes = getThemeModes(theme);
  return (
    <div
      className={
        "overflow-hidden rounded-md border " +
        (active ? "border-accent bg-wash" : "border-hairline bg-surface")
      }
    >
      <button
        type="button"
        onClick={onUse}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <span className="flex items-center -space-x-2">
          {modes.map((mode) => {
            const preview = previewOf(theme, mode);
            return (
              <ThemeSwatch
                key={mode}
                canvas={preview.canvas}
                sidebar={preview.sidebar}
                accent={preview.accent}
              />
            );
          })}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{theme.label}</span>
          <span className="block text-[11px] text-ink-muted">
            {modes.length === 2 ? "Light and dark" : modes[0] === "dark" ? "Dark" : "Light"}
            {active ? " · in use" : ""}
          </span>
        </span>
      </button>
      {onDownload || onRemove ? (
        <div className="flex justify-end gap-1 border-t border-hairline px-2 py-1.5">
          {onDownload ? (
            <Button variant="ghost" onClick={onDownload}>
              Export
            </Button>
          ) : null}
          {onRemove ? (
            <Button variant="ghost" onClick={onRemove}>
              Remove
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ThemeSettings() {
  const theme = useApp((s) => s.theme);
  const themeId = useApp((s) => s.themeId);
  const setTheme = useApp((s) => s.setTheme);
  const setThemeId = useApp((s) => s.setThemeId);
  const customThemes = useCustomThemes();
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const collections = new Map<string, { label: string; themes: ThemeDefinition[] }>();
    const ungrouped: ThemeDefinition[] = [];
    for (const item of customThemes) {
      if (!item.collection) {
        ungrouped.push(item);
        continue;
      }
      const group = collections.get(item.collection.id) ?? {
        label: item.collection.label,
        themes: [],
      };
      group.themes.push(item);
      collections.set(item.collection.id, group);
    }
    return { collections: [...collections.values()], ungrouped };
  }, [customThemes]);

  const selectTheme = useCallback(
    (id: string) => {
      setThemeId(id);
      setNotice(null);
    },
    [setThemeId],
  );

  return (
    <Card>
      <CardHeader
        title="Appearance"
        subtitle="Imported VS Code themes paint the chrome; chart series stay on the validated light/dark palettes"
        actions={
          <Button variant="primary" onClick={() => setImportOpen(true)}>
            Add theme
          </Button>
        }
      />

      <Segmented<ThemeMode>
        ariaLabel="Appearance"
        value={theme}
        onChange={setTheme}
        options={[
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />

      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
        <ThemeCard
          theme={DEFAULT_THEME}
          active={themeId === DEFAULT_THEME.id}
          onUse={() => selectTheme(DEFAULT_THEME.id)}
        />
        {grouped.ungrouped.map((item) => (
          <ThemeCard
            key={item.id}
            theme={item}
            active={themeId === item.id}
            onUse={() => selectTheme(item.id)}
            onDownload={() =>
              downloadThemeFile(`${item.id}.json`, serializeThemeFile(item))
            }
            onRemove={() => {
              removeCustomTheme(item.id);
              if (themeId === item.id) selectTheme(DEFAULT_THEME.id);
              setNotice(`Removed ${item.label}.`);
            }}
          />
        ))}
      </div>

      {grouped.collections.map((collection) => (
        <div key={collection.label} className="mt-4">
          <h3 className="mb-2 text-[12px] font-medium text-ink-secondary">{collection.label}</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
            {collection.themes.map((item) => (
              <ThemeCard
                key={item.id}
                theme={item}
                active={themeId === item.id}
                onUse={() => selectTheme(item.id)}
                onDownload={() =>
                  downloadThemeFile(`${item.id}.json`, serializeThemeFile(item))
                }
                onRemove={() => {
                  removeCustomTheme(item.id);
                  if (themeId === item.id) selectTheme(DEFAULT_THEME.id);
                  setNotice(`Removed ${item.label}.`);
                }}
              />
            ))}
          </div>
        </div>
      ))}

      {notice ? <p className="mt-3 text-[12px] text-ink-secondary">{notice}</p> : null}

      <ThemeImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={(imported) => {
          selectTheme(imported.id);
          setNotice(`Added ${imported.label}.`);
          return true;
        }}
        onImportedMany={(imported, context) => {
          const verb = context.updated ? "updated" : "added";
          if (imported.length === 1) {
            selectTheme(imported[0]!.id);
            setNotice(`${imported[0]!.label} ${verb}.`);
            return;
          }
          setNotice(`${imported.length} themes ${verb}.`);
        }}
      />
    </Card>
  );
}
