import { useApp } from "../lib/state/app";
import { useState } from "react";
import { PageShell } from "../components/PageShell";
import { Button, Callout, Card, CardHeader, DataTable, StatTile, full } from "../components/ui";
import { downloadOwnership, useLineOwnership, type ScanOptions } from "../lib/lineOwnership";

const inputClass = "w-full rounded-md border border-hairline-strong bg-surface px-2.5 py-2 text-[12px] text-ink";
const STORAGE_KEY = "github-monitor.line-ownership-options";
const defaults: ScanOptions = { repo: "", revision: "HEAD", groupBy: "person", pathspecs: [], excludes: [], includeGenerated: false, ignoreWhitespace: true, excludeBots: false };
function readOptions(): ScanOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return defaults;
    return {
      repo: typeof saved.repo === "string" ? saved.repo : "",
      revision: typeof saved.revision === "string" ? saved.revision : "HEAD",
      groupBy: ["person", "email", "name"].includes(saved.groupBy) ? saved.groupBy : "person",
      pathspecs: Array.isArray(saved.pathspecs) ? saved.pathspecs.filter((s: unknown) => typeof s === "string") : [],
      excludes: Array.isArray(saved.excludes) ? saved.excludes.filter((s: unknown) => typeof s === "string") : [],
      includeGenerated: saved.includeGenerated === true,
      ignoreWhitespace: saved.ignoreWhitespace !== false,
      excludeBots: saved.excludeBots === true,
    };
  } catch { return defaults; }
}

export function LineOwnership() {
  const repos = useApp((s) => s.repos);
  const selectedRepoIds = useApp((s) => s.selectedRepoIds);
  const [source, setSource] = useState<"github" | "local">("github");
  const [githubRepo, setGithubRepo] = useState(() => repos.find((r) => selectedRepoIds.includes(r.id))?.full_name ?? repos[0]?.full_name ?? "");
  const [options, setOptions] = useState(readOptions);
  const [paths, setPaths] = useState(() => options.pathspecs.join("\n"));
  const [excludes, setExcludes] = useState(() => options.excludes.join("\n"));
  const { report, running, cancelling, progress, error, scan, cancel } = useLineOwnership();
  const update = (patch: Partial<ScanOptions>) => setOptions((old) => ({ ...old, ...patch }));
  const start = () => {
    const lines = (text: string) => text.split("\n").map((s) => s.trim()).filter(Boolean);
    const request = { ...options, repo: options.repo.trim(), revision: options.revision.trim() || "HEAD", pathspecs: lines(paths), excludes: lines(excludes) };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(request)); } catch { /* A scan does not require storage. */ }
    void scan(request, source === "github" ? githubRepo : undefined);
  };
  return (
    <PageShell title="Line ownership" subtitle="Who last touched the lines that survive at a Git revision" filters={false} requiresData={false}>
      <Callout>
        Choose a GitHub repository to clone and update automatically, or scan an existing local clone with full history. Each surviving line is credited to its author and any co-authors.
        This view uses the repository and revision below; organisation, date and GitHub contributor filters do not apply.
      </Callout>
      <Card>
        <CardHeader title="Scan a repository" subtitle="Reads committed files only. Uncommitted changes are excluded. Large repositories can take several minutes." />
        <form onSubmit={(event) => { event.preventDefault(); start(); }} className="space-y-4">
          <fieldset disabled={running} className="space-y-4 disabled:opacity-60">
            <div className="flex gap-4 text-[12px] text-ink-secondary">
              <label><input type="radio" name="source" checked={source === "github"} onChange={() => setSource("github")} /> GitHub repository</label>
              <label><input type="radio" name="source" checked={source === "local"} onChange={() => setSource("local")} /> Local clone</label>
            </div>
            {source === "github" && <p className="text-[12px] text-ink-muted">Uses your saved GitHub token. Full history is downloaded into the app’s cache on the first scan and refreshed on later scans. Large repositories may require significant disk space.</p>}
            <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr]">
              {source === "github" ? <label className="space-y-1 text-[12px] text-ink-secondary">GitHub repository
                <select className={inputClass} value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} required>
                  <option value="" disabled>Choose a repository</option>
                  {repos.map((r) => <option key={r.id} value={r.full_name}>{r.full_name}</option>)}
                </select>
              </label> : <label className="space-y-1 text-[12px] text-ink-secondary">Local repository path
                <input className={inputClass} value={options.repo} onChange={(e) => update({ repo: e.target.value })} placeholder="/Users/you/projects/repository" required />
              </label>}
              <label className="space-y-1 text-[12px] text-ink-secondary">Revision
                <input className={inputClass} value={options.revision} onChange={(e) => update({ revision: e.target.value })} placeholder="HEAD" />
              </label>
              <label className="space-y-1 text-[12px] text-ink-secondary">Group identities by
                <select className={inputClass} value={options.groupBy} onChange={(e) => update({ groupBy: e.target.value as ScanOptions["groupBy"] })}>
                  <option value="person">Person</option><option value="email">Email</option><option value="name">Name</option>
                </select>
              </label>
            </div>
            <p className="text-[12px] text-ink-muted">Person grouping merges shared emails or names, including transitive aliases. Different people with the same name may merge; use Email to keep them separate. Git blame honours the clone’s .mailmap.</p>
            <details>
              <summary className="cursor-pointer text-[12px] text-ink-secondary">Scan options</summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="space-y-1 text-[12px] text-ink-secondary">Paths / Git pathspecs (one per line; blank means all files)
                  <textarea className={inputClass} rows={3} value={paths} onChange={(e) => setPaths(e.target.value)} placeholder={"src/\n*.py"} />
                </label>
                <label className="space-y-1 text-[12px] text-ink-secondary">Exclude globs (one per line)
                  <textarea className={inputClass} rows={3} value={excludes} onChange={(e) => setExcludes(e.target.value)} placeholder={"vendor/*\n*.generated.ts"} />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-4 text-[12px] text-ink-secondary">
                <label><input type="checkbox" checked={options.ignoreWhitespace} onChange={(e) => update({ ignoreWhitespace: e.target.checked })} /> Ignore whitespace changes</label>
                <label><input type="checkbox" checked={options.includeGenerated} onChange={(e) => update({ includeGenerated: e.target.checked })} /> Include generated files and lockfiles</label>
                <label><input type="checkbox" checked={options.excludeBots} onChange={(e) => update({ excludeBots: e.target.checked })} /> Exclude bots ([bot] or Copilot)</label>
              </div>
            </details>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" type="submit" disabled={running || (source === "github" ? !githubRepo : !options.repo.trim())}>{running ? "Scanning…" : "Scan line ownership"}</Button>
            {running && <Button onClick={() => void cancel()} disabled={cancelling}>{cancelling ? "Cancelling…" : "Cancel"}</Button>}
            <span role="status" className="text-[12px] text-ink-secondary">
              {running && (cancelling ? "Stopping after the current Git operation…" : progress ? `${progress.phase}${progress.total ? ` · ${full(progress.completed)} / ${full(progress.total)} files` : ""}` : "Resolving repository…")}
            </span>
          </div>
        </form>
      </Card>
      {error && <div role="alert"><Callout tone="warning">{error}</Callout></div>}
      {report && <>
        <Card>
          <CardHeader title="Ownership snapshot" subtitle={`${report.repo} · ${report.options.revision} (${report.revision.slice(0, 12)}) · grouped by ${report.options.groupBy}`}
            actions={<><Button onClick={() => downloadOwnership(report, "csv")}>Export CSV</Button><Button onClick={() => downloadOwnership(report, "json")}>Export JSON</Button></>} />
          <p className="text-[12px] text-ink-secondary">
            {report.options.pathspecs.length ? `Paths: ${report.options.pathspecs.join(", ")}. ` : "All paths. "}
            {report.options.ignoreWhitespace ? "Whitespace changes ignored. " : "Whitespace changes count. "}
            {report.options.includeGenerated ? "Generated files included. " : "Generated files excluded. "}
            {report.options.excludeBots ? "Bots excluded; lines with only bot credit are removed from the base. " : "Bots included. "}
            {report.options.excludes.length > 0 && `Extra exclusions: ${report.options.excludes.join(", ")}.`}
          </p>
        </Card>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Surviving lines" value={full(report.totalLines)} hint="Unique lines forming the share base" />
          <StatTile label="Person-line credits" value={full(report.creditedLines)} hint="Includes each co-author’s full credit" />
          <StatTile label="Co-authored lines" value={full(report.coauthoredLines)} hint="Lines credited to multiple identities" />
          <StatTile label="Files scanned" value={full(report.filesBlamed)} hint={`${full(Object.values(report.filesSkipped).reduce((a, b) => a + b, 0))} skipped`} />
        </div>
        <Callout>Shares use unique surviving lines as their base and can add up to more than 100% when co-authors share credit.</Callout>
        <Card>
          <CardHeader title="Authors" subtitle={`${full(report.authors.length)} identities with surviving lines`} />
          <DataTable rows={report.authors} rowKey={(row) => JSON.stringify([row.author, row.emails, row.names])} initialSort={{ key: "lines", dir: "desc" }} empty="No surviving lines match these scan options." columns={[
            { key: "author", header: "Author", render: (a) => a.author, sortValue: (a) => a.author },
            { key: "lines", header: "Lines", align: "right", render: (a) => full(a.lines), sortValue: (a) => a.lines },
            { key: "share", header: "Share", align: "right", render: (a) => `${(a.share * 100).toFixed(1)}%`, sortValue: (a) => a.share },
            { key: "aliases", header: "Names / emails", render: (a) => <span className="whitespace-normal break-all text-ink-secondary">{[...a.names, ...a.emails].join(" · ")}</span> },
          ]} />
        </Card>
        {Object.keys(report.filesSkipped).length > 0 && <Card>
          <CardHeader title="Skipped files" subtitle="Skipped files are excluded from the line totals. Blame failures mean the report is partial." />
          <ul className="space-y-1 text-[12px] text-ink-secondary">{Object.entries(report.filesSkipped).map(([reason, count]) => <li key={reason}>{full(count)} · {reason}</li>)}</ul>
        </Card>}
      </>}
    </PageShell>
  );
}
