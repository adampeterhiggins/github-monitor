import { useApp } from "../lib/state/app";
import { useUpdates } from "../lib/state/updates";
import { formatBytes, formatPublished } from "../lib/updates";
import { Button, Callout, Card, CardHeader, Spinner } from "./ui";

export function UpdatePanel() {
  const token = useApp((s) => s.token);
  const state = useUpdates();
  const pct = state.progress != null ? Math.round(state.progress * 100) : null;

  return (
    <Card>
      <CardHeader
        title="Updates"
        subtitle={
          state.currentVersion
            ? `Running version ${state.currentVersion}`
            : "Reading the current version…"
        }
        actions={
          <Button
            onClick={() => void state.check(true)}
            disabled={state.busy || state.phase === "downloading" || state.phase === "ready"}
          >
            {state.phase === "checking" ? <Spinner /> : null} Check now
          </Button>
        }
      />

      {state.phase === "error" && state.error ? (
        <div className="mb-3">
          <Callout tone="critical">{state.error}</Callout>
        </div>
      ) : null}

      {state.phase === "up-to-date" ? (
        <p className="text-[12px] text-ink-secondary">
          Up to date.
          {state.lastCheckedAt
            ? ` Last checked ${new Date(state.lastCheckedAt).toLocaleString("en-GB")}.`
            : ""}
        </p>
      ) : null}

      {state.phase === "available" ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-ink">
            Version <strong className="font-semibold">{state.availableVersion}</strong> is available
            {formatPublished(state.publishedAt)
              ? `, published ${formatPublished(state.publishedAt)}`
              : ""}
            .
          </p>
          {state.notes ? (
            <pre
              data-selectable
              className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-hairline bg-plane p-2.5 text-[11.5px] leading-relaxed text-ink-secondary"
            >
              {state.notes}
            </pre>
          ) : null}
          <div>
            <Button variant="primary" onClick={() => void state.download()}>
              Download and install
            </Button>
          </div>
        </div>
      ) : null}

      {state.phase === "downloading" ? (
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-[12px]">
            <span className="flex items-center gap-2 text-ink">
              <Spinner /> Downloading {state.availableVersion}
            </span>
            <span className="tabular text-ink-secondary">
              {pct != null ? `${pct}%` : formatBytes(state.downloadedBytes)}
              {state.totalBytes ? ` of ${formatBytes(state.totalBytes)}` : ""}
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full"
            style={{ background: "var(--wash-strong)" }}
          >
            <div
              className="h-full rounded-full transition-[width]"
              style={{ width: `${pct ?? 15}%`, background: "var(--accent)" }}
            />
          </div>
        </div>
      ) : null}

      {state.phase === "ready" ? (
        <div className="flex flex-col gap-2">
          <Callout>
            Version {state.availableVersion} is installed and takes effect after a restart.
            Restarting later costs nothing — the cache is on disk.
          </Callout>
          <div>
            <Button variant="primary" onClick={() => void state.restart()}>
              Restart now
            </Button>
          </div>
        </div>
      ) : null}

      {state.phase === "installing" ? (
        <p className="flex items-center gap-2 text-[12px] text-ink">
          <Spinner /> Restarting…
        </p>
      ) : null}

      <p className="mt-3 text-[11px] leading-relaxed text-ink-secondary">
        {token
          ? "Updates come from this app's own private repository, so the check reuses the GitHub token stored above. Only accounts with read access to that repository can update."
          : "Updates are served from a private repository and need the GitHub token above to authenticate. Add a token to enable update checks."}
      </p>
    </Card>
  );
}

/** Sidebar indicator, reading the same store so there is only ever one check. */
export function UpdateBadge({ onClick }: { onClick: () => void }) {
  const phase = useUpdates((s) => s.phase);
  const version = useUpdates((s) => s.availableVersion);

  if (!version || phase === "up-to-date" || phase === "idle" || phase === "checking") return null;

  const label =
    phase === "ready"
      ? `Restart for ${version}`
      : phase === "downloading"
        ? `Downloading ${version}…`
        : `Update to ${version}`;

  return (
    <button
      onClick={onClick}
      className="mb-1.5 w-full truncate rounded-md px-2.5 py-1.5 text-left text-[11.5px] font-medium"
      style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
    >
      {label}
    </button>
  );
}
