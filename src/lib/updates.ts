import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

/**
 * In-app updates.
 *
 * The release repository is private, so both the manifest and the binary need
 * authentication. Two things make that work without any Rust:
 *
 *  - the plugin sends configured request headers on *both* the manifest fetch and
 *    the artifact download, and only defaults `Accept` when the caller has not set
 *    it (`application/json` for the manifest, `application/octet-stream` for the
 *    download). Passing just `Authorization` therefore leaves both correct;
 *  - the manifest is served from `raw.githubusercontent.com`, which honours a
 *    bearer token on private repositories, and the manifest points the download at
 *    `api.github.com/.../releases/assets/<id>`, which does the same.
 *
 * Both were verified against this private repository before this was written:
 * authenticated requests return 200, unauthenticated ones 404.
 *
 * The token is the same one the app already stores for reading the GitHub API, so
 * updating requires no extra credential — but it does mean only people with read
 * access to the repository can update.
 */

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string | null;
  availableVersion: string | null;
  /** Release notes from the manifest, when present. */
  notes: string | null;
  publishedAt: string | null;
  /** 0..1 while downloading, null when unknown (no Content-Length). */
  progress: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  lastCheckedAt: string | null;
}

export const initialUpdateState: UpdateState = {
  phase: "idle",
  currentVersion: null,
  availableVersion: null,
  notes: null,
  publishedAt: null,
  progress: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
  lastCheckedAt: null,
};

export async function currentVersion(): Promise<string> {
  return getVersion();
}

function authHeaders(token: string | null): Record<string, string> | undefined {
  // Deliberately only Authorization: setting Accept here would break one of the
  // two requests, since they need different values.
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export interface CheckOutcome {
  update: Update | null;
  state: Partial<UpdateState>;
}

/**
 * Look for a newer release. Returns the `Update` handle so the caller can hand it
 * back to `installUpdate` without re-checking.
 */
export async function checkForUpdate(token: string | null): Promise<CheckOutcome> {
  const version = await currentVersion();
  const headers = authHeaders(token);

  const update = await check({ headers, timeout: 30_000 });
  const lastCheckedAt = new Date().toISOString();

  if (!update) {
    return {
      update: null,
      state: {
        phase: "up-to-date",
        currentVersion: version,
        availableVersion: null,
        notes: null,
        error: null,
        lastCheckedAt,
      },
    };
  }

  return {
    update,
    state: {
      phase: "available",
      currentVersion: update.currentVersion ?? version,
      availableVersion: update.version,
      notes: update.body ?? null,
      publishedAt: update.date ?? null,
      error: null,
      lastCheckedAt,
    },
  };
}

/**
 * Download and install, reporting progress. Does not relaunch — the caller decides
 * when to restart, so the user is never interrupted mid-task.
 */
export async function installUpdate(
  update: Update,
  token: string | null,
  onProgress: (patch: Partial<UpdateState>) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  onProgress({ phase: "downloading", downloadedBytes: 0, totalBytes: null, progress: null });

  await update.downloadAndInstall(
    (event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? null;
          onProgress({ totalBytes: total, downloadedBytes: 0, progress: total ? 0 : null });
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          onProgress({
            downloadedBytes: downloaded,
            progress: total ? Math.min(1, downloaded / total) : null,
          });
          break;
        case "Finished":
          onProgress({ phase: "ready", progress: 1 });
          break;
      }
    },
    { headers: authHeaders(token) },
  );

  onProgress({ phase: "ready", progress: 1 });
}

export async function restartToApply(): Promise<void> {
  await relaunch();
}

/**
 * Format the manifest's publish date for display.
 *
 * Tauri serialises `Update.date` from a Rust `OffsetDateTime`, which comes out like
 * `2026-08-11 15:00:00.0 +00:00:00` — not something `new Date()` parses. Rendering
 * it directly would show "Invalid Date", so normalise first and give up quietly if
 * it still will not parse.
 */
export function formatPublished(raw: string | null): string | null {
  if (!raw) return null;
  const candidates = [
    raw,
    // Space-separated date/time -> ISO, and drop the seconds-precision offset tail.
    raw.replace(" ", "T").replace(/ \+00:00:00$/, "Z").replace(/ ([+-]\d{2}):(\d{2}):\d{2}$/, "$1:$2"),
  ];
  for (const c of candidates) {
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    }
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`;
}

/**
 * Turn an updater failure into something a person can act on. The common ones are
 * all configuration or access problems rather than bugs.
 */
export function describeUpdateError(err: unknown): string {
  const message = (err as Error)?.message ?? String(err);

  if (/404|not found/i.test(message)) {
    return (
      "Could not read the update manifest (404). Either no release has been published yet, " +
      "or the stored GitHub token lacks read access to this repository."
    );
  }
  if (/401|403|unauthor|forbidden/i.test(message)) {
    return "GitHub rejected the credentials for the update check. Re-check the token in Settings.";
  }
  if (/signature|minisign|pubkey/i.test(message)) {
    return (
      "The downloaded update failed signature verification. It was not installed. " +
      "This usually means the release was signed with a different key than this build trusts."
    );
  }
  return message;
}
