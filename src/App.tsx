import { useEffect, useRef, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useApp, startThemeSync } from "./lib/state/app";
import { useUpdates } from "./lib/state/updates";
import { syncProblems } from "./lib/db/queries";
import { UpdateBadge } from "./components/UpdatePanel";
import { Button, Card, Spinner, full } from "./components/ui";
import { Setup } from "./pages/Setup";
import { Settings, SETTINGS_GROUPS, type SettingsSubId } from "./pages/Settings";
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
import { LineOwnership } from "./pages/LineOwnership";
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
  { id: "line-ownership", label: "Line ownership" },
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
  const [settingsSub, setSettingsSub] = useState<SettingsSubId>("repositories");
  // Where "Back" from settings lands — the page the user was actually on, not a
  // fixed default.
  const lastContentPage = useRef<PageId>("contributors");

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => startThemeSync(), []);

  // One updater poller for the whole app, so the sidebar badge and the Settings
  // card never issue competing checks.
  const startPoller = useUpdates((s) => s.startPoller);
  useEffect(() => startPoller(), [startPoller]);

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

  const navigate = (p: PageId) => {
    if (p !== "settings") lastContentPage.current = p;
    setPage(p);
  };

  const openSettings = (sub?: SettingsSubId) => {
    if (sub) setSettingsSub(sub);
    setPage("settings");
  };

  return (
    <div className="flex h-full">
      {page === "settings" ? (
        <SettingsSidebar
          sub={settingsSub}
          backLabel={
            NAV.find((i) => i.id === lastContentPage.current)?.label ?? "Back"
          }
          onSelect={setSettingsSub}
          onBack={() => setPage(lastContentPage.current)}
        />
      ) : (
        <Sidebar page={page} onNavigate={navigate} onOpenSettings={openSettings} />
      )}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Page page={page} settingsSub={settingsSub} />
      </main>
    </div>
  );
}

function NavGroup<I extends string>({
  label,
  items,
  current,
  onNavigate,
}: {
  label: string;
  items: ReadonlyArray<{ id: I; label: string; badge?: ReactNode }>;
  current: I;
  onNavigate: (p: I) => void;
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
              aria-current={current === item.id ? "page" : undefined}
              className={
                "mb-0.5 flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors " +
                (current === item.id
                  ? "bg-wash-strong font-medium text-ink"
                  : "text-ink-secondary hover:bg-wash hover:text-ink")
              }
            >
              <span className="min-w-0 truncate">{item.label}</span>
              {item.badge}
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}

function Sidebar({
  page,
  onNavigate,
  onOpenSettings,
}: {
  page: PageId;
  onNavigate: (p: PageId) => void;
  onOpenSettings: (sub?: SettingsSubId) => void;
}) {
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
        <NavGroup label="Insights" items={INSIGHTS} current={page} onNavigate={onNavigate} />
        <NavGroup label="Org views" items={ORG_VIEWS} current={page} onNavigate={onNavigate} />
      </ul>

      <div className="border-t border-hairline p-2">
        <UpdateBadge onClick={() => onOpenSettings("updates")} />
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={() => onOpenSettings()}
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

/**
 * While inside Settings the sidebar swaps to the subpage nav — the same pattern
 * as macOS System Settings. Live counts ride on the items that have something to
 * report: a spinner while a sync runs, the outstanding problem count, and the
 * pending update version.
 */
function SettingsSidebar({
  sub,
  backLabel,
  onSelect,
  onBack,
}: {
  sub: SettingsSubId;
  backLabel: string;
  onSelect: (s: SettingsSubId) => void;
  onBack: () => void;
}) {
  const org = useApp((s) => s.org);
  const db = useApp((s) => s.db);
  const syncing = useApp((s) => s.syncing);
  const lastSyncAt = useApp((s) => s.lastSyncAt);
  const updateVersion = useUpdates((s) => s.availableVersion);
  const updatePhase = useUpdates((s) => s.phase);

  const problems = useQuery({
    // Same key as the Sync problems subpage, so the badge and the table share
    // one query and clear together when an item is fixed.
    queryKey: ["sync-problems", syncing],
    enabled: db != null,
    queryFn: () => syncProblems(db!),
  });
  const problemCount = problems.data?.length ?? 0;
  const updatePending =
    updateVersion != null &&
    updatePhase !== "up-to-date" &&
    updatePhase !== "idle" &&
    updatePhase !== "checking";

  const badgeFor = (id: SettingsSubId): ReactNode => {
    switch (id) {
      case "sync":
        return syncing ? <Spinner /> : null;
      case "sync-problems":
        return problemCount > 0 ? (
          <span className="text-[10.5px] font-semibold tabular text-critical">
            {full(problemCount)}
          </span>
        ) : null;
      case "updates":
        return updatePending ? (
          <span className="text-[10.5px] font-semibold tabular text-accent">{updateVersion}</span>
        ) : null;
      default:
        return null;
    }
  };

  return (
    <nav className="flex w-[212px] shrink-0 flex-col border-r border-hairline bg-sidebar">
      <div className="px-4 pt-4 pb-3">
        <div className="text-[11px] uppercase tracking-wide text-ink-muted">
          Settings &amp; sync
        </div>
        <div className="mt-0.5 truncate text-[14px] font-semibold text-ink">{org}</div>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {SETTINGS_GROUPS.map((group) => (
          <NavGroup
            key={group.label}
            label={group.label}
            items={group.items.map((item) => ({ ...item, badge: badgeFor(item.id) }))}
            current={sub}
            onNavigate={onSelect}
          />
        ))}
      </ul>

      <div className="border-t border-hairline p-2">
        <UpdateBadge onClick={() => onSelect("updates")} />
        <Button variant="ghost" className="w-full justify-start" onClick={onBack}>
          ‹ Back to {backLabel}
        </Button>
        <p className="mt-1.5 px-1 text-[10px] leading-snug text-ink-muted">
          {lastSyncAt ? `Synced ${new Date(lastSyncAt).toLocaleString("en-GB")}` : "Never synced"}
        </p>
      </div>
    </nav>
  );
}

function Page({ page, settingsSub }: { page: PageId; settingsSub: SettingsSubId }) {
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
    case "line-ownership":
      return <LineOwnership />;
    case "ownership":
      return <Ownership />;
    case "people":
      return <People />;
    case "roster":
      return <Roster />;
    case "scorecard":
      return <Scorecard />;
    case "settings":
      return <Settings sub={settingsSub} />;
  }
}
