import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useApp, startThemeSync } from "./lib/state/app";
import { useUpdates } from "./lib/state/updates";
import { provideUpdateToken } from "./lib/state/updates";
import { UpdateBadge } from "./components/UpdatePanel";
import { Button, Card, Spinner } from "./components/ui";
import { Setup } from "./pages/Setup";
import { Settings } from "./pages/Settings";
import { Pulse } from "./pages/Pulse";
import { Contributors } from "./pages/Contributors";
import { Commits } from "./pages/Commits";
import { CodeFrequency } from "./pages/CodeFrequency";
import { PunchCardPage } from "./pages/PunchCardPage";
import { Community } from "./pages/Community";
import { Traffic } from "./pages/Traffic";
import { Dependencies } from "./pages/Dependencies";
import { Network } from "./pages/Network";
import { Forks } from "./pages/Forks";
import { ActionsUsage } from "./pages/ActionsUsage";
import { ActionsPerformance } from "./pages/ActionsPerformance";
import { Ownership } from "./pages/Ownership";
import { People } from "./pages/People";
import { Roster } from "./pages/Roster";
import { Scorecard } from "./pages/Scorecard";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

/** Nav mirrors GitHub's Insights sidebar, in the same order. */
const INSIGHTS = [
  { id: "pulse", label: "Pulse" },
  { id: "contributors", label: "Contributors" },
  { id: "community", label: "Community" },
  { id: "traffic", label: "Traffic" },
  { id: "commits", label: "Commits" },
  { id: "code-frequency", label: "Code frequency" },
  { id: "punch-card", label: "Punch card" },
  { id: "dependencies", label: "Dependency graph" },
  { id: "network", label: "Network" },
  { id: "forks", label: "Forks" },
  { id: "actions-usage", label: "Actions usage metrics" },
  { id: "actions-performance", label: "Actions performance metrics" },
] as const;

/** Views GitHub has no equivalent of — joins and history the website will not show. */
const ORG_VIEWS = [
  { id: "ownership", label: "Ownership" },
  { id: "people", label: "People" },
  { id: "roster", label: "Roster" },
  { id: "scorecard", label: "Scorecard" },
] as const;

const NAV = [...INSIGHTS, ...ORG_VIEWS] as const;

type PageId = (typeof NAV)[number]["id"] | "settings";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}

function Shell() {
  const { booted, bootError, boot, token, org } = useApp();
  const [page, setPage] = useState<PageId>("contributors");

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => startThemeSync(), []);

  // One updater poller for the whole app, so the sidebar badge and the Settings
  // card never issue competing checks. The token is read lazily so one added
  // after launch is picked up.
  const startPoller = useUpdates((s) => s.startPoller);
  useEffect(() => {
    provideUpdateToken(() => useApp.getState().token);
    return startPoller();
  }, [startPoller]);

  if (!booted) {
    return (
      <div className="flex h-full items-center justify-center text-ink-secondary">
        <Spinner size={18} />
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Card className="max-w-lg">
          <h1 className="mb-2 text-[15px] font-semibold text-ink">Could not start</h1>
          <p className="text-[12px] leading-relaxed text-ink-secondary">{bootError}</p>
        </Card>
      </div>
    );
  }

  if (!token || !org) return <Setup />;

  return (
    <div className="flex h-full">
      <Sidebar page={page} onNavigate={setPage} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Page page={page} />
      </main>
    </div>
  );
}

function NavGroup({
  label,
  items,
  page,
  onNavigate,
}: {
  label: string;
  items: ReadonlyArray<{ id: PageId; label: string }>;
  page: PageId;
  onNavigate: (p: PageId) => void;
}) {
  return (
    <li className="list-none">
      <div className="px-2.5 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </div>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button
              onClick={() => onNavigate(item.id)}
              aria-current={page === item.id ? "page" : undefined}
              className={
                "mb-0.5 w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors " +
                (page === item.id
                  ? "bg-wash-strong font-medium text-ink"
                  : "text-ink-secondary hover:bg-wash hover:text-ink")
              }
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}

function Sidebar({ page, onNavigate }: { page: PageId; onNavigate: (p: PageId) => void }) {
  const org = useApp((s) => s.org);
  const lastSyncAt = useApp((s) => s.lastSyncAt);
  const syncing = useApp((s) => s.syncing);
  const repos = useApp((s) => s.repos);
  const selected = useApp((s) => s.selectedRepoIds);

  return (
    <nav className="flex w-[212px] shrink-0 flex-col border-r border-hairline bg-sidebar">
      <div className="px-4 pt-4 pb-3">
        <div className="text-[11px] uppercase tracking-wide text-ink-muted">Organisation</div>
        <div className="mt-0.5 truncate text-[14px] font-semibold text-ink">{org}</div>
        <div className="mt-0.5 text-[11px] tabular text-ink-muted">
          {selected.length} of {repos.length} repos
        </div>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <NavGroup label="Insights" items={INSIGHTS} page={page} onNavigate={onNavigate} />
        <NavGroup label="Org views" items={ORG_VIEWS} page={page} onNavigate={onNavigate} />
      </ul>

      <div className="border-t border-hairline p-2">
        <UpdateBadge onClick={() => onNavigate("settings")} />
        <Button
          variant={page === "settings" ? "default" : "ghost"}
          className="w-full justify-start"
          onClick={() => onNavigate("settings")}
        >
          {syncing ? <Spinner /> : null} Settings &amp; sync
        </Button>
        <p className="mt-1.5 px-1 text-[10px] leading-snug text-ink-muted">
          {lastSyncAt ? `Synced ${new Date(lastSyncAt).toLocaleString("en-GB")}` : "Never synced"}
        </p>
      </div>
    </nav>
  );
}

function Page({ page }: { page: PageId }) {
  switch (page) {
    case "pulse":
      return <Pulse />;
    case "contributors":
      return <Contributors />;
    case "community":
      return <Community />;
    case "traffic":
      return <Traffic />;
    case "commits":
      return <Commits />;
    case "code-frequency":
      return <CodeFrequency />;
    case "punch-card":
      return <PunchCardPage />;
    case "dependencies":
      return <Dependencies />;
    case "network":
      return <Network />;
    case "forks":
      return <Forks />;
    case "actions-usage":
      return <ActionsUsage />;
    case "actions-performance":
      return <ActionsPerformance />;
    case "ownership":
      return <Ownership />;
    case "people":
      return <People />;
    case "roster":
      return <Roster />;
    case "scorecard":
      return <Scorecard />;
    case "settings":
      return <Settings />;
  }
}
