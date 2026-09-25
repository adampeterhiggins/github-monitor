import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useApp } from "../lib/state/app";
import { PageShell } from "../components/PageShell";
import { LineOwnershipCharts, OwnershipHistoryChart } from "../components/LineOwnershipCharts";
import { OwnershipInspector } from "../components/OwnershipInspector";
import { UserFilter } from "../components/UserFilter";
import { RepoFilter } from "../components/RepoFilter";
import { PeriodFilter } from "../components/FilterBar";
import { Button, Callout, Card, CardHeader, DataTable, EmptyState, Spinner, StatTile, full } from "../components/ui";
import { aggregateOwnership, contributorsFromOwnership, downloadOwnership, ownershipIdentity, type OwnershipReport } from "../lib/lineOwnership";
import { NO_CONTRIBUTORS } from "../lib/contributorSelection";
import { ownershipAccountIndex, ownershipAccountRevision, ownershipDays, ownershipReport, ownershipRevisions, type OwnershipRevision } from "../lib/db/lineOwnership";
import { normalizeRepoHistory, type NormalizedRepoHistory, type RepoHistoryData } from "../lib/ownershipHistory";
import { EMPTY_ACCOUNT_INDEX } from "../lib/ownershipIdentity";
import { subscribeOwnership } from "../lib/ownershipEvents";
import { measure } from "../lib/perf";
import { useScope } from "../lib/hooks";
import { formatDate } from "../lib/agg/weeks";

// Stable references keep useQueries from re-running its combine on every render.
const combineReports = (results: UseQueryResult<OwnershipReport | null>[]) => ({
  data: results.map((r) => r.data ?? null),
  loading: results.some((r) => r.isLoading),
  fetching: results.map((r) => r.isFetching),
  error: results.find((r) => r.error)?.error ?? null,
});
const combineHistories = (results: UseQueryResult<RepoHistoryData>[]) => ({
  data: results.map((r) => r.data ?? null),
  loading: results.some((r) => r.isLoading),
  fetching: results.some((r) => r.isFetching),
  error: results.find((r) => r.error)?.error ?? null,
});

/** The same array while its elements are the same objects, so unchanged repositories reuse every memo. */
function useShallowStable<T>(list: T[]): T[] {
  const ref = useRef(list);
  if (ref.current.length !== list.length || ref.current.some((value, i) => value !== list[i])) ref.current = list;
  return ref.current;
}

/** Refetch revisions after durable writes. History batches refresh at most this often. */
const HISTORY_REFRESH_MS = 1500;

export function LineOwnership() {
  const db = useApp((s) => s.db);
  const selectedRepoIds = useApp((s) => s.selectedRepoIds);
  const syncing = useApp((s) => s.syncing);
  const botPatterns = useApp((s) => s.botPatterns);
  const selectedLogins = useApp((s) => s.selectedLogins);
  const queryClient = useQueryClient();
  const { range } = useScope();
  const period = useApp((s) => s.period);
  const repoIds = useMemo(() => [...selectedRepoIds].sort((a, b) => a - b), [selectedRepoIds]);
  const repoKey = repoIds.join(",");

  // A cheap probe: status and revisions only. Heavy reads below are keyed by
  // these, so a repository that did not change is never read or parsed again.
  const revisions = useQuery({
    queryKey: ["line-ownership-revisions", repoKey],
    enabled: db != null && repoIds.length > 0,
    queryFn: () => ownershipRevisions(db!, repoIds),
    placeholderData: keepPreviousData,
    // Recovery for missed events and changes made outside this window.
    refetchOnWindowFocus: true,
    refetchInterval: syncing ? 30_000 : false,
  });
  const accountRevision = useQuery({
    queryKey: ["ownership-account-revision"],
    enabled: db != null,
    queryFn: () => ownershipAccountRevision(db!),
    refetchOnWindowFocus: true,
    refetchInterval: syncing ? 30_000 : false,
  });
  const accounts = useQuery({
    queryKey: ["ownership-account-index", accountRevision.data],
    enabled: db != null && accountRevision.data != null,
    queryFn: () => ownershipAccountIndex(db!),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refreshRevisions = (delay: number) => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: ["line-ownership-revisions"] });
      }, delay);
    };
    const unsubscribe = subscribeOwnership((event) => {
      if (event.kind === "accounts" || event.kind === "mappings") {
        void queryClient.invalidateQueries({ queryKey: ["ownership-account-revision"] });
        return;
      }
      if (!repoIds.includes(event.repoId)) return;
      refreshRevisions(event.kind === "history" && !event.done ? HISTORY_REFRESH_MS : 0);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [queryClient, repoIds]);

  const rows: OwnershipRevision[] = repoIds.length ? revisions.data ?? [] : [];
  const reportQueries = useQueries({
    queries: rows.map((row) => ({
      queryKey: ["line-ownership-report", row.repoId, row.reportRevision],
      enabled: db != null && row.hasReport,
      queryFn: () => ownershipReport(db!, row.repoId),
      staleTime: Infinity,
      gcTime: 10 * 60_000,
      // A repository being updated, cancelled or failed keeps its last report.
      placeholderData: keepPreviousData,
    })),
    combine: combineReports,
  });
  const historyQueries = useQueries({
    queries: rows.map((row) => ({
      queryKey: ["line-ownership-days", row.repoId, row.historyRevision],
      enabled: db != null && row.history.kind !== "none",
      queryFn: () => ownershipDays(db!, row.repoId, row.history),
      staleTime: Infinity,
      gcTime: 10 * 60_000,
      placeholderData: keepPreviousData,
    })),
    combine: combineHistories,
  });

  const accountIndex = accounts.data ?? EMPTY_ACCOUNT_INDEX;
  // Unchanged repositories keep their report objects, so identity and per-report
  // caches survive another repository's update.
  const reportList = reportQueries.data;
  const namesKey = rows.map((row) => `${row.repoId}\0${row.fullName}`).join("\n");
  const nameOf = useMemo(() => new Map(rows.map((row) => [row.repoId, row.fullName])), [namesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const currentReports = useShallowStable(rows.flatMap((row, i) => row.hasReport && reportList[i] ? [reportList[i]!] : []));
  const currentReportIds = useShallowStable(rows.flatMap((row, i) => row.hasReport && reportList[i] ? [row.repoId] : []));
  const withReports = useMemo(() => ({ reports: currentReports, repoIds: currentReportIds }), [currentReports, currentReportIds]);
  const historyList = useShallowStable(historyQueries.data.filter((h): h is RepoHistoryData => h != null));
  const histories = useMemo(() => historyList.map(normalizeRepoHistory) as NormalizedRepoHistory[], [historyList]);

  // A new selection or grouping walks every credit. Let the control paint first
  // and keep the previous figures until that walk finishes.
  const deferredReports = useDeferredValue(withReports);
  const deferredHistories = useDeferredValue(histories);
  const deferredLogins = useDeferredValue(selectedLogins);
  const reports = deferredReports.reports;
  const reportRepoIds = deferredReports.repoIds;
  const chartRepositories = useMemo(() => reportRepoIds.map((id) => ({ id, name: nameOf.get(id) ?? `Repository ${id}` })), [reportRepoIds, nameOf]);
  const historyRepositories = useMemo(() => [...nameOf].map(([id, name]) => ({ id, name })), [nameOf]);
  const identity = useMemo(() => measure("ownership:snapshot-identity", () => ownershipIdentity(reports, accountIndex, reportRepoIds)), [reports, accountIndex, reportRepoIds]);
  const everyone = useMemo(() => aggregateOwnership(reports, "person", [], identity, reportRepoIds), [reports, identity, reportRepoIds]);
  const contributors = useMemo(() => contributorsFromOwnership(everyone, botPatterns), [everyone, botPatterns]);
  const summary = useMemo(() => deferredLogins.length === 0
    ? everyone
    : aggregateOwnership(reports, "person", deferredLogins, identity, reportRepoIds),
  [everyone, reports, deferredLogins, identity, reportRepoIds]);
  const summaryStale = deferredReports !== withReports || deferredLogins !== selectedLogins;
  const historyStale = deferredHistories !== histories || deferredLogins !== selectedLogins;
  const filteredLinesByRepo = useMemo(() => new Map(chartRepositories.map((r, i) => [r.id, summary.byRepository[i]?.totalLines ?? 0])), [chartRepositories, summary]);
  const [inspectRepoId, setInspectRepoId] = useState<number | null>(null);
  const inspectRef = useRef<HTMLDivElement>(null);
  // Until one is chosen, inspect the repository with the most surviving lines.
  const inspected = inspectRepoId != null && rows.some((r) => r.repoId === inspectRepoId && r.hasReport)
    ? inspectRepoId
    : [...filteredLinesByRepo].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const inspect = (repoId: number) => {
    setInspectRepoId(repoId);
    inspectRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const missing = rows.filter((r) => !r.hasReport).length;
  const failed = rows.filter((r) => r.status === "error").length;
  const legacy = rows.filter((r) => r.history.kind === "legacy").length;
  const unmatchedPeople = everyone.authors.filter((a) => a.matched === false).length;
  const loadingReports = revisions.isLoading || reportQueries.loading;
  const exportReport = {
    authors: summary.authors.map(({ key: _key, ...author }) => author), totalLines: summary.totalLines,
    creditedLines: summary.creditedLines, coauthoredLines: summary.coauthoredLines, groupBy: "person",
    selectedContributors: deferredLogins.length ? deferredLogins.filter((login) => login !== NO_CONTRIBUTORS) : null,
    identityRules: { accountRevision: accountIndex.revision },
    repositories: rows.map((r) => ({
      repository: r.fullName, revision: r.revision, calculatedAt: r.calculatedAt, checkedAt: r.checkedAt, status: r.status,
      totalLines: filteredLinesByRepo.get(r.repoId) ?? null,
    })),
  };
  const error = revisions.error ?? reportQueries.error ?? accounts.error;
  return (
    <PageShell title="Line ownership" subtitle="Who owns the surviving code across your organisation" filters={false} requiresData={false}
      filterContent={<div className="flex flex-wrap items-center gap-3 border-b border-hairline bg-plane px-5 py-2.5">
        <PeriodFilter />
        <RepoFilter />
        <UserFilter support="full" snapshot={{ contributors, isLoading: loadingReports }} />
        {reports.length > 0 && <><Button onClick={() => downloadOwnership(exportReport, "csv")}>Export CSV</Button><Button onClick={() => downloadOwnership(exportReport, "json")}>Export JSON</Button></>}
        <span className="ml-auto text-[11px] text-ink-muted" title="The period limits Ownership over time. Surviving-line figures describe the latest synced default branches.">
          {period === "all" ? "All history" : `${formatDate(range.fromMs)} – ${formatDate(range.toMs)}`} · latest synced default branches
        </span>
      </div>}>
      {syncing && <div role="status" className="flex items-center gap-2 text-[12px] text-ink-secondary"><Spinner /> Sync in progress. Each repository refreshes on its own as it is saved.</div>}
      {error && <Callout tone="critical">Could not load ownership: {error.message}</Callout>}
      {historyQueries.error && <Callout tone="critical">Could not load ownership history: {historyQueries.error.message}</Callout>}
      {loadingReports && <div role="status"><Spinner /> Loading saved ownership…</div>}
      {!repoIds.length ? <EmptyState title="No repositories selected" body="Choose repositories in the filter above." /> : !loadingReports && !reports.length ?
        <EmptyState title="No line ownership synced yet" body="Run Sync now in Settings & sync. Line ownership is calculated and saved for every selected repository alongside the other analytics. Full re-sync rebuilds it from scratch." /> : null}
      {(missing > 0 || failed > 0) && <Callout tone="warning">
        {missing > 0 && `${full(missing)} selected ${missing === 1 ? "repository has" : "repositories have"} no saved ownership yet. `}
        {failed > 0 && `${full(failed)} failed their latest ownership sync; any previous successful snapshots are retained. `}
        Run Sync changes or Resume in Settings & sync to refresh them.
      </Callout>}
      {legacy > 0 && <Callout tone="info">
        History for {full(legacy)} {legacy === 1 ? "repository was" : "repositories were"} saved before contributor matching and may combine people who share a name. It is rebuilt with account-level detail on the next sync; until then manual mappings apply to its current snapshot but not to its history.
      </Callout>}
      {reports.length > 0 && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Surviving lines" value={full(summary.totalLines)} hint="Unique lines in the synced code" />
          <StatTile label="People" value={full(summary.authors.length)} hint={`${full(unmatchedPeople)} unmatched Git identities`} />
          <StatTile label="Co-authored lines" value={full(summary.coauthoredLines)} hint={`${full(summary.creditedLines)} person-line credits`} />
          <StatTile label="Repositories" value={`${full(reports.length)} / ${full(repoIds.length)}`} hint="With a saved ownership snapshot" />
        </div>
        {histories.length === 0 && !historyQueries.loading && !historyQueries.fetching && !historyStale
          ? <p className="text-[12px] text-ink-muted">Ownership history builds during sync. The daily chart appears once each default-branch commit has been recorded.</p>
          : <OwnershipHistoryChart histories={deferredHistories} selectedLogins={deferredLogins} accounts={accountIndex}
            loading={historyQueries.loading || historyStale} repositories={historyRepositories}
            window={period === "all" ? null : { fromMs: range.fromMs, toMs: range.toMs }} />}
        <LineOwnershipCharts summary={summary} repositories={chartRepositories} loading={reportQueries.fetching.some(Boolean) || summaryStale} />
        <div ref={inspectRef} className="scroll-mt-4">
          <OwnershipInspector rows={rows} identity={identity} selectedLogins={deferredLogins} repoId={inspected} onRepoChange={setInspectRepoId} />
        </div>
        <p className="text-[12px] text-ink-muted">Person grouping is by GitHub account: every email GitHub or a manual mapping links to an account counts as that login, the same login the Contributors page shows. Authors marked * have no GitHub match: they are unmatched Git identities and are never joined by name; map them in Settings → Contributor mappings. The Top owners table lists each person's Git names and emails.</p>
      </>}
      {rows.length > 0 && <Card>
        <CardHeader title="Repository snapshots" subtitle="Saved commit and last successful calculation for each repository. Sync changes updates touched files; Full re-sync rebuilds all ownership." />
        <DataTable rows={rows} rowKey={(r) => r.repoId} columns={[
          { key: "repo", header: "Repository", render: (r) => r.hasReport
            ? <button className="text-left text-accent hover:underline" title="Inspect this repository" onClick={() => inspect(r.repoId)}>{r.fullName}</button>
            : r.fullName, sortValue: (r) => r.fullName },
          { key: "lines", header: "Lines", align: "right", render: (r) => r.hasReport ? full(filteredLinesByRepo.get(r.repoId) ?? 0) : "—", sortValue: (r) => filteredLinesByRepo.get(r.repoId) ?? -1 },
          { key: "commit", header: "Commit", render: (r) => r.revision ? <code title={r.revision}>{r.revision.slice(0, 12)}</code> : r.hasReport ? "Empty repository" : "—" },
          { key: "calculated", header: "Calculated", render: (r) => r.calculatedAt ? new Date(r.calculatedAt).toLocaleString() : "—", sortValue: (r) => r.calculatedAt ?? "" },
          { key: "history", header: "History", render: (r) => historyLabel(r) },
          { key: "status", header: "Last sync", render: (r) => <span title={r.error ?? (r.checkedAt ? `Checked ${new Date(r.checkedAt).toLocaleString()}` : undefined)}>{r.status === "error" ? `Failed${r.hasReport ? " · showing saved data" : ""}: ${r.error ?? "Unknown error"}` : r.status === "pending" ? `${syncing ? "Updating" : "Interrupted"}${r.hasReport ? " · showing saved data" : ""}` : r.hasReport ? "Synced" : "Not yet synced"}</span> },
        ]} />
        <p className="mt-3 text-[12px] text-ink-muted">Line totals follow the grouping and contributor filters. Attribution ignores whitespace-only edits. Generated files, binaries, symlinks and submodules are excluded. {full(reports.reduce((n, r) => n + Object.values(r.filesSkipped).reduce((a, b) => a + b, 0), 0))} files skipped across these snapshots.</p>
      </Card>}
    </PageShell>
  );
}

function historyLabel(row: OwnershipRevision): string {
  if (row.history.kind === "none") return row.historyStatus === "building" ? "Recording…" : "Not recorded";
  if (row.history.kind === "legacy") return row.historyStatus === "building" ? "Legacy · rebuilding" : "Legacy · awaiting rebuild";
  if (row.historyStatus === "failed") return `Previous history kept · ${row.historyError ?? "rebuild failed"}`;
  if (row.history.partial) return "Recording…";
  return row.historyStatus === "building" ? "Complete · rebuilding" : "Complete";
}
