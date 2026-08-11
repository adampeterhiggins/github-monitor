import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useApp, type ThemeMode } from "../lib/state/app";
import { clearAnalytics } from "../lib/db";
import { syncProblems } from "../lib/db/queries";
import { clearToken } from "../lib/auth";
import { ENDPOINT_LABELS, type EndpointId } from "../lib/ingest/sync";
import { Button, Callout, Card, CardHeader, DataTable, Segmented } from "../components/ui";
import { SyncPanel } from "../components/SyncPanel";
import { RepoSelectionPanel } from "../components/RepoSelectionPanel";
import { PageShell } from "../components/PageShell";

export function Settings() {
  const { db, org, theme, setTheme, setOrg, refreshRepos } = useApp();
  const queryClient = useQueryClient();
  const [orgInput, setOrgInput] = useState(org ?? "");
  const [notice, setNotice] = useState<string | null>(null);

  const problems = useQuery({
    queryKey: ["sync-problems"],
    enabled: db != null,
    queryFn: () => syncProblems(db!),
  });

  return (
    <PageShell
      title="Settings & sync"
      subtitle="Local cache, credentials and appearance"
      filters={false}
      requiresData={false}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <RepoSelectionPanel />

        <SyncPanel />

        <Card>
          <CardHeader title="Organisation" subtitle="Switching keeps the existing cache on disk" />
          <div className="flex gap-2">
            <input
              value={orgInput}
              onChange={(e) => setOrgInput(e.target.value)}
              className="h-8 flex-1 rounded-md border border-hairline-strong bg-surface px-2.5 text-[12px] text-ink focus:outline-2 focus:outline-offset-0 focus:outline-accent"
            />
            <Button
              size="md"
              onClick={async () => {
                await setOrg(orgInput);
                await queryClient.invalidateQueries();
                setNotice(`Switched to ${orgInput}. Run a sync to populate it.`);
              }}
              disabled={!orgInput.trim() || orgInput === org}
            >
              Switch
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="Appearance" subtitle="Dark mode uses a separately validated palette" />
          <Segmented<ThemeMode>
            ariaLabel="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </Card>

        <Card>
          <CardHeader
            title="Incomplete data"
            subtitle="Repositories where a sync did not complete"
            actions={
              <Button onClick={() => void problems.refetch()}>Refresh</Button>
            }
          />
          <DataTable
            rows={problems.data ?? []}
            maxHeight={280}
            empty="Everything synced cleanly"
            rowKey={(r, i) => `${r.full_name}:${r.endpoint}:${i}`}
            columns={[
              { key: "repo", header: "Repository", render: (r) => r.full_name },
              {
                key: "endpoint",
                header: "Data",
                render: (r) => ENDPOINT_LABELS[r.endpoint as EndpointId] ?? r.endpoint,
              },
              {
                key: "status",
                header: "Status",
                render: (r) =>
                  r.status === "pending" ? "Still computing on GitHub" : (r.error ?? r.status),
              },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Local cache" subtitle="Stored in the app's data directory" />
          {notice ? (
            <div className="mb-3">
              <Callout>{notice}</Callout>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={async () => {
                if (!db) return;
                await clearAnalytics(db);
                await queryClient.invalidateQueries();
                await refreshRepos();
                setNotice(
                  "Cached analytics cleared. Traffic history was kept, since GitHub only serves the last 14 days and cannot supply it again.",
                );
              }}
            >
              Clear cached analytics
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await clearToken();
                setNotice("Token removed. Reopen the app to sign in again.");
              }}
            >
              Remove stored token
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="How these numbers are produced" />
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[12px] leading-relaxed text-ink-secondary">
            <li>
              Commit, contributor and code-frequency figures come from GitHub's own{" "}
              <code className="text-ink">stats</code> endpoints — the same source as the
              Insights pages — so per-repository totals match the website exactly. They cover
              the default branch and exclude merge commits.
            </li>
            <li>
              GitHub computes those statistics on demand and answers{" "}
              <code className="text-ink">202 Accepted</code> with no body while a repository's
              cache is cold. A first sync therefore asks for every repository up front, then
              collects the results on a second pass.
            </li>
            <li>
              Pulse has no dedicated endpoint. It is derived from pull requests and issues
              fetched over GraphQL, so its definitions are ours rather than GitHub's.
            </li>
            <li>
              Traffic is limited to 14 days by GitHub. Each sync appends to a local table, so
              history accumulates from the day you start syncing; nothing earlier can be
              recovered.
            </li>
            <li>Contributors are shown by raw login, with no bot classification or alias merging.</li>
          </ul>
        </Card>
      </div>
    </PageShell>
  );
}
