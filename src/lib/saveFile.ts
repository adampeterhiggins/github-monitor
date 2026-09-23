import { invoke } from "@tauri-apps/api/core";

export interface SaveFileOptions {
  /** Suggested file name, without a directory. */
  name: string;
  contents: string;
  /** Label and extensions for the dialog's file type filter, e.g. `JSON`, `["json"]`. */
  filter: { name: string; extensions: readonly string[] };
  mime: string;
}

/**
 * Save through the system save dialog. Resolves to the saved path, or null when
 * the dialog was cancelled. Outside the desktop app (tests, a plain browser) it
 * falls back to a browser download and resolves to the suggested name.
 */
export async function saveTextFile(options: SaveFileOptions): Promise<string | null> {
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (native) {
    return invoke<string | null>("save_text_file", {
      defaultName: options.name,
      contents: options.contents,
      filterName: options.filter.name,
      extensions: options.filter.extensions,
    });
  }
  const url = URL.createObjectURL(new Blob([options.contents], { type: options.mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = options.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return options.name;
}

export const JSON_FILE = { filter: { name: "JSON", extensions: ["json"] }, mime: "application/json" } as const;
export const CSV_FILE = { filter: { name: "CSV", extensions: ["csv"] }, mime: "text/csv;charset=utf-8" } as const;
