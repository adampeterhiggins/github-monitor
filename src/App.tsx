import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useApp } from "./lib/state/app";
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

/** Nav mirrors GitHub's Insights sidebar, in the same order. */
const NAV = [
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

function Sidebar({ page, onNavigate }: { page: PageId; onNavigate: (p: PageId) => void }) {
  const org = useApp((s) => s.org);
  const lastSyncAt = useApp((s) => s.lastSyncAt);
  const syncing = useApp((s) => s.syncing);
  const repos = useApp((s) => s.repos);
  const selected = useApp((s) => s.selectedRepoIds);

  return (
    <nav className="flex w-[212px] shrink-0 flex-col border-r border-hairline bg-plane">
      <div className="px-4 pt-4 pb-3">
        <div className="text-[11px] uppercase tracking-wide text-ink-muted">Organisation</div>
        <div className="mt-0.5 truncate text-[14px] font-semibold text-ink">{org}</div>
        <div className="mt-0.5 text-[11px] tabular text-ink-muted">
          {selected.length} of {repos.length} repos
        </div>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {NAV.map((item) => (
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
    case "settings":
      return <Settings />;
  }
}
