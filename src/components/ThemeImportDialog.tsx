import { createPortal } from "react-dom";
import type { ChangeEvent, DragEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCustomThemes,
  installCustomTheme,
  parseThemeFile,
  removeCustomTheme,
  THEME_FILE_VERSION,
  updateCustomTheme,
  type ThemeDefinition,
} from "../lib/theme/palette";
import {
  humanizeThemeName,
  isVsCodeThemeFile,
  pairVsCodeThemes,
  parseVsCodeThemeFile,
  resolveThemeLabelCollisions,
} from "../lib/theme/vscodeImport";
import { ThemeSearchSection } from "./ThemeSearchSection";
import { Button } from "./ui";

export const MAX_THEME_FILE_BYTES = 256 * 1024;

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export function describeOversizedThemeFile(bytes: number): string | null {
  if (bytes <= MAX_THEME_FILE_BYTES) return null;
  return `That file is ${formatByteSize(bytes)}. Theme files are only a few KB, so this one was not read (limit ${formatByteSize(MAX_THEME_FILE_BYTES)}).`;
}

function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="theme-import-title"
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      style={{ background: "color-mix(in srgb, var(--page-plane) 75%, transparent)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-lg">
        <header className="border-b border-hairline px-4 py-3">
          <h2 id="theme-import-title" className="text-[15px] font-semibold text-ink">
            {title}
          </h2>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        <footer className="flex justify-end gap-2 border-t border-hairline px-4 py-3">{footer}</footer>
      </section>
    </div>,
    document.body,
  );
}

type ImportableThemeFile = { name: string; size: number; text: () => Promise<string> };

export function ThemeImportDialog({
  open,
  onOpenChange,
  onImported,
  onImportedMany,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (theme: ThemeDefinition) => boolean;
  onImportedMany: (themes: ReadonlyArray<ThemeDefinition>, context: { updated: boolean }) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [conflicts, setConflicts] = useState<ReadonlyArray<ThemeDefinition> | null>(null);
  const importRequestRef = useRef(0);

  useEffect(() => {
    importRequestRef.current += 1;
    setIsDropTarget(false);
    if (!open) return;
    setJson("");
    setFileName(null);
    setError(null);
    setIsReading(false);
    setConflicts(null);
  }, [open]);

  const readThemeFile = useCallback(async (file: ImportableThemeFile) => {
    const oversized = describeOversizedThemeFile(file.size);
    if (oversized) {
      setError(oversized);
      return;
    }
    const requestId = ++importRequestRef.current;
    setIsReading(true);
    try {
      const fileText = await file.text();
      if (requestId !== importRequestRef.current) return;
      setJson(fileText);
      setFileName(file.name);
      setError(null);
    } catch {
      if (requestId !== importRequestRef.current) return;
      setError("Could not read that file. Paste the JSON below instead.");
    } finally {
      if (requestId === importRequestRef.current) setIsReading(false);
    }
  }, []);

  const readThemeBatch = useCallback(
    async (files: ReadonlyArray<ImportableThemeFile>) => {
      const requestId = ++importRequestRef.current;
      setIsReading(true);
      const failures: string[] = [];
      const parsed: Array<{ theme: ThemeDefinition; sourceName: string }> = [];
      try {
        for (const file of files) {
          const oversized = describeOversizedThemeFile(file.size);
          if (oversized) {
            failures.push(`${file.name}: too large`);
            continue;
          }
          try {
            const value: unknown = JSON.parse(await file.text());
            parsed.push({
              sourceName: file.name,
              theme: isVsCodeThemeFile(value) ? parseVsCodeThemeFile(value) : parseThemeFile(value),
            });
          } catch (cause) {
            failures.push(
              `${file.name}: ${cause instanceof Error ? cause.message : "not a theme file"}`,
            );
          }
        }
        if (requestId !== importRequestRef.current) return;
        const installed: ThemeDefinition[] = [];
        const conflicting: ThemeDefinition[] = [];
        for (const theme of pairVsCodeThemes(resolveThemeLabelCollisions(parsed))) {
          if (getCustomThemes().some((existing) => existing.id === theme.id)) {
            conflicting.push(theme);
            continue;
          }
          try {
            installed.push(installCustomTheme(theme));
          } catch (cause) {
            failures.push(
              `${theme.label}: ${cause instanceof Error ? cause.message : "could not install"}`,
            );
          }
        }
        if (installed.length > 0) onImportedMany(installed, { updated: false });
        if (failures.length > 0) setError(failures.join(" — "));
        else if (conflicting.length > 0) setConflicts(conflicting);
        else if (installed.length > 0) onOpenChange(false);
      } finally {
        if (requestId === importRequestRef.current) setIsReading(false);
      }
    },
    [onImportedMany, onOpenChange],
  );

  const readThemeFiles = useCallback(
    (files: ReadonlyArray<ImportableThemeFile>) => {
      if (files.length === 0) return;
      if (files.length === 1) void readThemeFile(files[0]!);
      else void readThemeBatch(files);
    },
    [readThemeBatch, readThemeFile],
  );

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = [...(event.currentTarget.files ?? [])];
      event.currentTarget.value = "";
      readThemeFiles(files);
    },
    [readThemeFiles],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropTarget(false);
      readThemeFiles([...event.dataTransfer.files]);
    },
    [readThemeFiles],
  );

  const versionedCopy = (theme: ThemeDefinition, preferredName?: string | null): ThemeDefinition => {
    if (preferredName && preferredName.toLowerCase() !== theme.label.toLowerCase()) {
      const candidate = parseThemeFile({
        version: THEME_FILE_VERSION,
        name: preferredName.slice(0, 48),
        appearance: theme.appearance,
        colors: theme.colors,
        ...(theme.variants ? { variants: theme.variants } : {}),
        ...(theme.managed ? { managed: true } : {}),
      });
      if (!getCustomThemes().some((existing) => existing.id === candidate.id)) return candidate;
    }
    for (let copy = 1; copy < 100; copy += 1) {
      const candidate = parseThemeFile({
        version: THEME_FILE_VERSION,
        name: `${theme.label.slice(0, 48 - ` (${copy})`.length)} (${copy})`,
        appearance: theme.appearance,
        colors: theme.colors,
        ...(theme.variants ? { variants: theme.variants } : {}),
        ...(theme.managed ? { managed: true } : {}),
      });
      if (getCustomThemes().some((existing) => existing.id === candidate.id)) continue;
      return candidate;
    }
    throw new Error(`Too many copies of "${theme.label}".`);
  };

  const resolveConflicts = useCallback(
    (mode: "update" | "copy") => {
      if (!conflicts) return;
      const resolved: ThemeDefinition[] = [];
      const failures: string[] = [];
      const preferredName =
        conflicts.length === 1 && fileName
          ? humanizeThemeName(fileName.replace(/\.[^.]+$/, ""))
          : null;
      for (const theme of conflicts) {
        try {
          const existingTheme =
            mode === "update"
              ? getCustomThemes().find((candidate) => candidate.id === theme.id)
              : undefined;
          const themeToUpdate = existingTheme?.collection
            ? { ...theme, collection: existingTheme.collection }
            : theme;
          resolved.push(
            mode === "update"
              ? updateCustomTheme(themeToUpdate)
              : installCustomTheme(versionedCopy(theme, preferredName)),
          );
        } catch (cause) {
          failures.push(`${theme.label}: ${cause instanceof Error ? cause.message : "failed"}`);
        }
      }
      if (resolved.length > 0) onImportedMany(resolved, { updated: mode === "update" });
      setConflicts(null);
      if (failures.length > 0) setError(failures.join(" — "));
      else onOpenChange(false);
    },
    [conflicts, fileName, onImportedMany, onOpenChange],
  );

  const handleSubmit = useCallback(() => {
    const oversized = describeOversizedThemeFile(json.length);
    if (oversized) {
      setError(oversized);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      const theme = isVsCodeThemeFile(parsed)
        ? parseVsCodeThemeFile(parsed)
        : parseThemeFile(parsed);
      if (getCustomThemes().some((existing) => existing.id === theme.id)) {
        setError(null);
        setConflicts([theme]);
        return;
      }
      const installedTheme = installCustomTheme(theme);
      if (!onImported(installedTheme)) {
        try {
          removeCustomTheme(installedTheme.id);
        } catch {
          // Storage is failing wholesale; the error below covers it.
        }
        setError("Theme added, but it could not be selected. Try again.");
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That theme file is invalid.");
    }
  }, [json, onImported, onOpenChange]);

  if (!open) return null;

  return (
    <Dialog
      title="Add a theme"
      onClose={() => onOpenChange(false)}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!json.trim() || isReading} onClick={handleSubmit}>
            Add theme
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <ThemeSearchSection
          open={open}
          onInstalled={(themes, context) => {
            onImportedMany(themes, context);
            onOpenChange(false);
          }}
        />

        <div className="flex items-center gap-3" aria-hidden>
          <div className="h-px flex-1 bg-hairline" />
          <span className="text-[11px] uppercase tracking-wider text-ink-muted">or import a file</span>
          <div className="h-px flex-1 bg-hairline" />
        </div>

        {conflicts ? (
          <div className="space-y-3">
            <div className="rounded-md border border-hairline bg-wash p-3">
              <p className="text-[13px] font-medium text-ink">Already installed</p>
              <p className="mt-1 text-[12px] text-ink-secondary">
                {conflicts.map((theme) => theme.label).join(", ")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => resolveConflicts("update")}>
                Update existing
              </Button>
              <Button onClick={() => resolveConflicts("copy")}>Keep both</Button>
              <Button variant="ghost" onClick={() => setConflicts(null)}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div
              className={
                "flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed px-3 py-3 " +
                (isDropTarget ? "border-accent bg-wash" : "border-hairline bg-wash")
              }
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDropTarget(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDropTarget(true);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setIsDropTarget(false);
              }}
              onDrop={handleDrop}
            >
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ink">Theme file</p>
                <p className="truncate text-[12px] text-ink-muted">
                  {fileName ?? "Drop a T3 Code or VS Code .json file"}
                </p>
              </div>
              <Button disabled={isReading} onClick={() => fileInputRef.current?.click()}>
                {isReading ? "Reading…" : "Choose files"}
              </Button>
              <input
                ref={fileInputRef}
                accept=".json,application/json"
                className="sr-only"
                multiple
                type="file"
                onChange={handleFileChange}
              />
            </div>
            <label className="block text-[13px] font-medium text-ink" htmlFor="theme-json-editor">
              Theme JSON
            </label>
            <textarea
              id="theme-json-editor"
              aria-label="Theme JSON"
              className="block min-h-48 w-full resize-y rounded-md border border-hairline-strong bg-plane p-3 font-mono text-[12px] leading-5 text-ink focus:outline-2 focus:outline-offset-0 focus:outline-accent"
              onChange={(event) => setJson(event.currentTarget.value)}
              placeholder='{ "version": 1, "name": "Aurora", "appearance": "light", "colors": { ... } }'
              spellCheck={false}
              value={json}
            />
          </div>
        )}

        {error ? (
          <p className="text-[12px] text-critical" aria-live="polite">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
