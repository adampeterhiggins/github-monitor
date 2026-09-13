import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useApp } from "../lib/state/app";
import { clearAnalytics } from "../lib/db";
import { syncProblems, type SyncProblem } from "../lib/db/queries";
import { useRepoSync } from "../lib/state/repoSync";
import { clearToken } from "../lib/auth";
import { ENDPOINT_LABELS, type EndpointId } from "../lib/ingest/sync";
import { Button, Callout, Card, CardHeader, DataTable, Spinner, full } from "../components/ui";
import { SyncPanel } from "../components/SyncPanel";
import { RepoSelectionPanel } from "../components/RepoSelectionPanel";
import { SavedSelectionsPanel } from "../components/SavedSelectionsPanel";
import { BotPatternsPanel } from "../components/BotPatternsPanel";
import { UpdatePanel } from "../components/UpdatePanel";
import { ThemeSettings } from "../components/ThemeSettings";
import { PageShell } from "../components/PageShell";

/**
 * Settings is split into subpages. While inside, the sidebar swaps its usual
 * Insights nav for these groups (see SettingsSidebar in App.tsx), so every
 * subpage is one focused screen rather than a card in a long scroll.
 */
export type SettingsSubId =
  | "repositories"
  | "sync"
  | "sync-problems"
  | "saved-selections"
  | "bots"
  | "organisation"
  | "cache"
  | "appearance"
  | "updates"
  | "about";

export const SETTINGS_GROUPS: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ id: SettingsSubId; label: string }>;
}> = [
  {
    label: "Data & sync",
    items: [
      { id: "repositories", label: "Repositories" },
      { id: "sync", label: "Sync" },
      { id: "sync-problems", label: "Sync problems" },
    ],
  },
  {
    label: "Filtering",
    items: [
      { id: "saved-selections", label: "Saved selections" },
      { id: "bots", label: "Bots & agents" },
    ],
  },
  {
    label: "Organisation",
    items: [
      { id: "organisation", label: "Organisation" },
      { id: "cache", label: "Cache & sign-in" },
    ],
  },
  {
    label: "Application",
    items: [
      { id: "appearance", label: "Appearance" },
      { id: "updates", label: "Updates" },
      { id: "about", label: "About the data" },
    ],
  },
];

export function Settings({ sub }: { sub: SettingsSubId }) {
  switch (sub) {
    case "repositories":
      return (
        <SubPage
          title="Repositories"
          subtitle="Choose the set of repositories every page aggregates across"
        >
          <RepoSelectionPanel />
        </SubPage>
      );
    case "sync":
      return (
        <SubPage title="Sync" subtitle="Fetch analytics into the local cache">
          <SyncPanel />
        </SubPage>
      );
    case "sync-problems":
      return (
        <SubPage title="Sync problems" subtitle="Repositories where a sync did not complete">
          <SyncProblemsCard />
        </SubPage>
      );
    case "saved-selections":
      return (
        <SubPage
          title="Saved selections"
          subtitle="Named groups of repositories or contributors"
        >
          <SavedSelectionsPanel />
        </SubPage>
      );
    case "bots":
      return (
        <SubPage
          title="Bots & agents"
          subtitle="Login patterns the contributor filter can deselect in one go"
        >
          <BotPatternsPanel />
        </SubPage>
      );
    case "organisation":
      return (
        <SubPage title="Organisation" subtitle="Switching keeps the existing cache on disk">
          <OrganisationCard />
        </SubPage>
      );
    case "cache":
      return (
        <SubPage
          title="Cache & sign-in"
          subtitle="The local analytics cache and the stored GitHub token"
        >
          <CacheCard />
        </SubPage>
      );
    case "appearance":
      return (
        <SubPage title="Appearance" subtitle="Light, dark, or an imported VS Code theme">
          <ThemeSettings />
        </SubPage>
      );
    case "updates":
      return (
        <SubPage title="Updates" subtitle="Checked against the project's GitHub releases">
          <UpdatePanel />
        </SubPage>
      );
    case "about":
      return (
        <SubPage title="About the data" subtitle="How these numbers are produced">
          <AboutCard />
        </SubPage>
      );
  }
}

function SubPage({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <PageShell title={title} subtitle={subtitle} filters={false} requiresData={false}>
      {/* Wide enough for the repository table to lay out rather than scroll inside
          its card — it carries seven columns, and at 3xl the dates wrapped over
          three lines. Still capped, so prose lines stay readable on a wide display,
          but the cap is now above any window this is used on rather than below. */}
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4">{children}</div>
    </PageShell>
  );
}

/**
 * Pair-level retries for syncs that never finished. No repo ids are needed for
 * the controller here: this list only uses the pair-level retry.
 */
function SyncProblemsCard() {
  const db = useApp((s) => s.db);
  const syncing = useApp((s) => s.syncing);
  const problems = useQuery({
    // Re-reads when a sync finishes, so a fixed item leaves the list by itself.
    queryKey: ["sync-problems", syncing],
    enabled: db != null,
    queryFn: () => syncProblems(db!),
  });
  const repoSync = useRepoSync([]);

  const retryAll = async () => {
    // Sequential on purpose. Each retry is itself a small sync, and running them
    // concurrently would fight over the same rate limit and write lock.
    for (const p of problems.data ?? []) {
      await repoSync.retryPair(p.repo_id, p.endpoint as EndpointId);
    }
    await problems.refetch();
  };

  return (
    <Card>
      <CardHeader
        title="Incomplete data"
        subtitle="Repositories where a sync did not complete"
        actions={
          <>
            {(problems.data?.length ?? 0) > 0 ? (
              <Button
                variant="primary"
                disabled={repoSync.busy}
                onClick={() => void retryAll()}
                title="Retry every item below, one at a time"
              >
                Retry all ({full(problems.data?.length ?? 0)})
              </Button>
            ) : null}
            <Button disabled={repoSync.busy} onClick={() => void problems.refetch()}>
              Refresh
            </Button>
          </>
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
            render: (r: SyncProblem) => (
              <span
                title={
                  r.last_attempt_at
                    ? `${full(r.attempts)} attempt${r.attempts === 1 ? "" : "s"}, last ${new Date(r.last_attempt_at).toLocaleString("en-GB")}`
                    : undefined
                }
              >
                {r.status === "pending" ? "Still computing on GitHub" : (r.error ?? r.status)}
              </span>
            ),
          },
          {
            key: "retry",
            header: "",
            align: "right",
            width: "90px",
            render: (r: SyncProblem) => {
              const active = repoSync.activePair === `${r.repo_id}:${r.endpoint}`;
              return active ? (
                <span className="flex items-center justify-end gap-1.5 text-[11px] text-ink">
                  <Spinner /> retrying
                </span>
              ) : (
                <Button
                  variant="ghost"
                  disabled={repoSync.busy}
                  onClick={() => void repoSync.retryPair(r.repo_id, r.endpoint as EndpointId)}
                  title={
                    r.status === "pending"
                      ? "Ask GitHub again — it may have finished computing by now"
                      : "Retry just this item"
                  }
                >
                  Retry
                </Button>
              );
            },
          },
        ]}
      />
    </Card>
  );
}

function OrganisationCard() {
  const { org, setOrg } = useApp();
  const queryClient = useQueryClient();
  const [orgInput, setOrgInput] = useState(org ?? "");
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader title="Organisation" subtitle="Switching keeps the existing cache on disk" />
      {notice ? (
        <div className="mb-3">
          <Callout>{notice}</Callout>
        </div>
      ) : null}
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
  );
}

function CacheCard() {
  const { db, refreshRepos } = useApp();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  return (
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
  );
}

function AboutCard() {
  return (
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
  );
}
