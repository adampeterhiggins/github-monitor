import { Channel, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useApp } from "./state/app";

export interface ScanOptions {
  repo: string;
  revision: string;
  groupBy: "person" | "email" | "name";
  pathspecs: string[];
  excludes: string[];
  includeGenerated: boolean;
  ignoreWhitespace: boolean;
  excludeBots: boolean;
}
export interface OwnershipAuthor {
  author: string;
  names: string[];
  emails: string[];
  lines: number;
  share: number;
}
export interface OwnershipReport {
  repo: string;
  revision: string;
  options: ScanOptions;
  filesBlamed: number;
  filesSkipped: Record<string, number>;
  totalLines: number;
  creditedLines: number;
  coauthoredLines: number;
  authors: OwnershipAuthor[];
}
interface Progress { completed: number; total: number; phase: string }
interface ScanState {
  report: OwnershipReport | null;
  running: boolean;
  cancelling: boolean;
  progress: Progress | null;
  error: string | null;
  scan: (options: ScanOptions, githubRepo?: string) => Promise<void>;
  cancel: () => Promise<void>;
}

// Scans and their last result survive navigation between pages.
export const useLineOwnership = create<ScanState>((set, get) => ({
  report: null, running: false, cancelling: false, progress: null, error: null,
  scan: async (options, githubRepo) => {
    if (get().running) return;
    set({ running: true, cancelling: false, error: null, report: null, progress: null });
    try {
      const onProgress = new Channel<Progress>();
      onProgress.onmessage = (progress) => set({ progress });
      const report = await invoke<OwnershipReport>("scan_line_ownership", { options, onProgress, githubRepo: githubRepo ?? null, token: githubRepo ? useApp.getState().token : null });
      set({ report });
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ running: false, cancelling: false });
    }
  },
  cancel: async () => {
    set({ cancelling: true });
    try { await invoke("cancel_line_ownership"); }
    catch (error) { set({ error: String(error), cancelling: false }); }
  },
}));

export function ownershipCsv(report: OwnershipReport): string {
  // Quote every field and neutralise spreadsheet formulas in Git author metadata.
  const cell = (value: string | number) => {
    let text = String(value);
    if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows: (string | number)[][] = [
    ["author", "lines", "share", "emails"],
    ...report.authors.map((a) => [a.author, a.lines, a.share, a.emails.join(";")]),
    ["Surviving lines", report.totalLines, "", ""],
  ];
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function downloadOwnership(report: OwnershipReport, format: "json" | "csv") {
  const body = format === "json" ? JSON.stringify(report, null, 2) + "\n" : ownershipCsv(report);
  const url = URL.createObjectURL(new Blob([body], { type: format === "json" ? "application/json" : "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `line-ownership-${report.revision.slice(0, 12)}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
