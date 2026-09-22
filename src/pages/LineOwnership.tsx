import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApp } from "../lib/state/app";
import { PageShell } from "../components/PageShell";
import { LineOwnershipCharts } from "../components/LineOwnershipCharts";
import { RepoFilter } from "../components/RepoFilter";
import { Button, Callout, Card, CardHeader, DataTable, EmptyState, Spinner, StatTile, full } from "../components/ui";
import { aggregateOwnership, downloadOwnership, type GroupBy, type OwnershipReport } from "../lib/lineOwnership";
import { ownershipSnapshots } from "../lib/db/lineOwnership";

export function LineOwnership() {
  const db = useApp((s) => s.db);
  const selectedRepoIds = useApp((s) => s.selectedRepoIds);
  const syncing = useApp((s) => s.syncing);
  const botPatterns = useApp((s) => s.botPatterns);
  const [groupBy, setGroupBy] = useState<GroupBy>("person");
  const [excludeBots, setExcludeBots] = useState(false);
  const repoIds = [...selectedRepoIds].sort((a, b) => a - b);
  const snapshots = useQuery({
    queryKey: ["line-ownership", repoIds.join(","), syncing],
    enabled: db != null && repoIds.length > 0,
    queryFn: () => ownershipSnapshots(db!, repoIds),
    // Completed repositories become visible while the rest of the org syncs.
    refetchInterval: syncing ? 5000 : false,
  });
  const rows = repoIds.length ? snapshots.data ?? [] : [];
  const chartRepositories = useMemo(() => rows.filter((r) => r.report != null).map((r) => ({ id: r.repo_id, name: r.full_name })), [rows]);
  const reports = useMemo(() => rows.map((r) => r.report).filter((r): r is OwnershipReport => r != null), [rows]);
  const summary = useMemo(() => aggregateOwnership(reports, groupBy, excludeBots, botPatterns), [reports, groupBy, excludeBots, botPatterns]);
  const filteredLinesByRepo = useMemo(() => new Map(chartRepositories.map((r, i) => [r.id, summary.byRepository[i].totalLines])), [chartRepositories, summary]);
  const missing = rows.filter((r) => !r.report).length;
  const failed = rows.filter((r) => r.status === "error").length;
  const exportReport = { authors: summary.authors, totalLines: summary.totalLines, creditedLines: summary.creditedLines,
    coauthoredLines: summary.coauthoredLines, groupBy, excludeBots, botPatterns, repositories: rows.map((r) => ({
    repository: r.full_name, revision: r.revision, calculatedAt: r.calculated_at, checkedAt: r.checked_at, status: r.status, totalLines: filteredLinesByRepo.get(r.repo_id) ?? null,
  })) };
  return (
    <PageShell title="Line ownership" subtitle="Who owns the surviving code across your organisation" filters={false} requiresData={false}
      filterContent={<div className="flex flex-wrap items-center gap-3 border-b border-hairline bg-plane px-5 py-2.5">
        <RepoFilter />
        <label className="flex items-center gap-2 text-[12px] text-ink-secondary">Group by
          <select className="rounded-md border border-hairline bg-surface px-2 py-1 text-ink" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="person">Person</option><option value="email">Email</option><option value="name">Name</option>
          </select>
        </label>
        <label className="text-[12px] text-ink-secondary" title="Uses the shared bot patterns from Settings → Bots and agents, matched against every name and email alias."><input type="checkbox" checked={excludeBots} onChange={(e) => setExcludeBots(e.target.checked)} /> Exclude bots</label>
        {reports.length > 0 && <><Button onClick={() => downloadOwnership(exportReport, "csv")}>Export CSV</Button><Button onClick={() => downloadOwnership(exportReport, "json")}>Export JSON</Button></>}
        <span className="ml-auto text-[11px] text-ink-muted">Latest synced default branches</span>
      </div>}>
      {syncing && <div role="status" className="flex items-center gap-2 text-[12px] text-ink-secondary"><Spinner /> Sync in progress. Completed repositories appear as they are saved.</div>}
      {snapshots.error && <Callout tone="critical">Could not load ownership: {snapshots.error.message}</Callout>}
      {snapshots.isLoading && <div role="status"><Spinner /> Loading saved ownership…</div>}
      {!repoIds.length ? <EmptyState title="No repositories selected" body="Choose repositories in the filter above." /> : !snapshots.isLoading && !reports.length ?
        <EmptyState title="No line ownership synced yet" body="Run Sync now in Settings & sync. Line ownership is calculated and saved for every selected repository alongside the other analytics. Full re-sync rebuilds it from scratch." /> : null}
      {(missing > 0 || failed > 0) && <Callout tone="warning">
        {missing > 0 && `${full(missing)} selected ${missing === 1 ? "repository has" : "repositories have"} no saved ownership yet. `}
        {failed > 0 && `${full(failed)} failed their latest ownership sync; any previous successful snapshots are retained. `}
        Run Sync changes or Resume in Settings & sync to refresh them.
      </Callout>}
      {reports.length > 0 && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Surviving lines" value={full(summary.totalLines)} hint="Unique lines in the synced code" />
          <StatTile label="People" value={full(summary.authors.length)} hint={`Grouped by ${groupBy}`} />
          <StatTile label="Co-authored lines" value={full(summary.coauthoredLines)} hint={`${full(summary.creditedLines)} person-line credits`} />
          <StatTile label="Repositories" value={`${full(reports.length)} / ${full(repoIds.length)}`} hint="With a saved ownership snapshot" />
        </div>
        <LineOwnershipCharts summary={summary} repositories={chartRepositories} />
        <p className="text-[12px] text-ink-muted">Person grouping merges shared names and emails across repositories. Use Email to separate people who share a name. Exclude bots uses the same built-in rules and saved patterns as the other pages.</p>
      </>}
      {rows.length > 0 && <Card>
        <CardHeader title="Repository snapshots" subtitle="Saved commit and last successful calculation for each repository. Sync changes updates touched files; Full re-sync rebuilds all ownership." />
        <DataTable rows={rows} rowKey={(r) => r.repo_id} columns={[
          { key: "repo", header: "Repository", render: (r) => r.full_name, sortValue: (r) => r.full_name },
          { key: "lines", header: "Lines", align: "right", render: (r) => r.report ? full(filteredLinesByRepo.get(r.repo_id) ?? 0) : "—", sortValue: (r) => filteredLinesByRepo.get(r.repo_id) ?? -1 },
          { key: "commit", header: "Commit", render: (r) => r.revision ? <code title={r.revision}>{r.revision.slice(0, 12)}</code> : r.report ? "Empty repository" : "—" },
          { key: "calculated", header: "Calculated", render: (r) => r.calculated_at ? new Date(r.calculated_at).toLocaleString() : "—", sortValue: (r) => r.calculated_at ?? "" },
          { key: "status", header: "Last sync", render: (r) => <span title={r.error ?? (r.checked_at ? `Checked ${new Date(r.checked_at).toLocaleString()}` : undefined)}>{r.status === "error" ? `Failed${r.report ? " · showing saved data" : ""}: ${r.error ?? "Unknown error"}` : r.status === "pending" ? `${syncing ? "Updating" : "Interrupted"}${r.report ? " · showing saved data" : ""}` : r.report ? "Synced" : "Not yet synced"}</span> },
        ]} />
        <p className="mt-3 text-[12px] text-ink-muted">Line totals follow the grouping and bot filters. Attribution ignores whitespace-only edits. Generated files, binaries, symlinks and submodules are excluded. {full(reports.reduce((n, r) => n + Object.values(r.filesSkipped).reduce((a, b) => a + b, 0), 0))} files skipped across these snapshots.</p>
      </Card>}
    </PageShell>
  );
}
