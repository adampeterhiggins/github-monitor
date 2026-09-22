import { useMemo, useState } from "react";
import type { aggregateOwnership } from "../lib/lineOwnership";
import { HeatMatrix, RankedBars } from "./charts";
import { ChartCard, DataTable, Segmented, full } from "./ui";

type Summary = ReturnType<typeof aggregateOwnership>;
const percent = (value: number) => `${value.toFixed(1)}%`;
const share = (value: number) => percent(value * 100);
const shortRepo = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/** All views use the same globally resolved identities and surviving-line base. */
export function LineOwnershipCharts({ summary, repositories }: {
  summary: Summary;
  /** Same order as the reports passed to aggregateOwnership. */
  repositories: Array<{ id: number; name: string }>;
}) {
  const [measure, setMeasure] = useState<"share" | "lines">("share");
  const [limit, setLimit] = useState<"12" | "24" | "all">("12");
  const repoRows = useMemo(() => repositories.map((repo, i) => {
    const data = summary.byRepository[i];
    return { ...repo, ...data, topAuthor: data.authors[0]?.author ?? "—", topShare: data.authors[0]?.share ?? 0 };
  }).sort((a, b) => b.topShare - a.topShare || b.totalLines - a.totalLines || a.name.localeCompare(b.name)), [summary, repositories]);
  const topAuthors = summary.authors.slice(0, 12);
  const topRepos = repoRows.filter((r) => r.totalLines > 0).slice(0, 12);
  const matrix = useMemo(() => {
    const count = limit === "all" ? Infinity : Number(limit);
    const people = summary.authors.slice(0, count);
    const repos = [...repoRows].filter((r) => r.totalLines > 0)
      .sort((a, b) => b.totalLines - a.totalLines || a.name.localeCompare(b.name)).slice(0, count);
    const byRepo = repos.map((repo) => new Map(repo.authors.map((a) => [a.key, a])));
    const cellAt = (row: number, col: number) => byRepo[col].get(people[row].key);
    const values = people.map((_, row) => repos.map((__, col) => cellAt(row, col)?.[measure] ?? 0));
    return { people, repos, cellAt, values };
  }, [summary, repoRows, limit, measure]);
  const cells = useMemo(() => repoRows.flatMap((repo) => repo.authors.map((author) => ({
    ...author, repoId: repo.id, repository: repo.name,
  }))), [repoRows]);

  return <>
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <ChartCard title="Top owners"
        subtitle={`${topAuthors.length < summary.authors.length ? `Top ${topAuthors.length} of ${full(summary.authors.length)} identities` : "Every credited identity"} · share of surviving lines`}
        table={<DataTable rows={summary.authors} rowKey={(a) => a.key} maxHeight={400} initialSort={{ key: "lines", dir: "desc" }} empty="No surviving lines match these filters." columns={[
          { key: "author", header: "Author", render: (a) => a.author, sortValue: (a) => a.author },
          { key: "lines", header: "Lines", align: "right", render: (a) => full(a.lines), sortValue: (a) => a.lines },
          { key: "share", header: "Share", align: "right", render: (a) => share(a.share), sortValue: (a) => a.share },
          { key: "aliases", header: "Names / emails", render: (a) => <span className="whitespace-normal break-all text-ink-secondary">{[...a.names, ...a.emails].join(" · ")}</span> },
        ]} />}>
        <RankedBars data={topAuthors.map((a) => ({ name: a.author, value: a.share * 100 }))} height={360}
          domain={[0, 100]} showAxis labelWidth={160} truncateLabels valueLabel="of surviving lines" valueFormatter={percent} />
      </ChartCard>
      <ChartCard title="Repository concentration"
        subtitle="Highest top-owner shares · all repositories are available in the table"
        table={<DataTable rows={repoRows} rowKey={(r) => r.id} maxHeight={400} initialSort={{ key: "share", dir: "desc" }} columns={[
          { key: "repo", header: "Repository", render: (r) => r.name, sortValue: (r) => r.name },
          { key: "owner", header: "Top owner", render: (r) => r.topAuthor },
          { key: "share", header: "Top-owner share", align: "right", render: (r) => r.totalLines ? share(r.topShare) : "—", sortValue: (r) => r.topShare },
          { key: "lines", header: "Surviving lines", align: "right", render: (r) => full(r.totalLines), sortValue: (r) => r.totalLines },
          { key: "people", header: "People", align: "right", render: (r) => full(r.authors.length), sortValue: (r) => r.authors.length },
        ]} />}>
        <RankedBars data={topRepos.map((r) => ({ name: r.name, value: r.topShare * 100 }))} height={360}
          domain={[0, 100]} showAxis labelWidth={160} truncateLabels valueLabel="credited to the top owner" valueFormatter={percent} />
      </ChartCard>
    </div>
    <p className="text-[12px] text-ink-muted">Co-authors each receive full credit, so author shares can add up to more than 100%. Repository concentration shows one person’s share of that repository’s surviving lines.</p>
    <ChartCard title="People × repositories"
      subtitle={`${full(matrix.people.length)} of ${full(summary.authors.length)} identities · ${full(matrix.repos.length)} of ${full(repoRows.filter((r) => r.totalLines > 0).length)} repositories with lines · ${measure === "share" ? "colour shows share within each repository" : "colour shows credited lines"}`}
      titleAfter={<div className="flex flex-wrap gap-2">
        <Segmented ariaLabel="Heatmap measure" value={measure} onChange={setMeasure} options={[{ value: "share", label: "Share" }, { value: "lines", label: "Lines" }]} />
        <select aria-label="Heatmap size" value={limit} onChange={(e) => setLimit(e.target.value as typeof limit)} className="h-7 rounded-md border border-hairline bg-surface px-2 text-[11px] text-ink">
          <option value="12">Top 12</option><option value="24">Top 24</option><option value="all">All</option>
        </select>
      </div>}
      table={<DataTable rows={cells} rowKey={(r) => `${r.repoId}:${r.key}`} maxHeight={420} initialSort={{ key: "lines", dir: "desc" }} empty="No surviving lines match these filters." columns={[
        { key: "author", header: "Author", render: (r) => r.author, sortValue: (r) => r.author },
        { key: "repo", header: "Repository", render: (r) => r.repository, sortValue: (r) => r.repository },
        { key: "lines", header: "Lines", align: "right", render: (r) => full(r.lines), sortValue: (r) => r.lines },
        { key: "share", header: "Repository share", align: "right", render: (r) => share(r.share), sortValue: (r) => r.share },
      ]} />}>
      <HeatMatrix rowLabels={matrix.people.map((p) => p.author)} columnLabels={matrix.repos.map((r) => shortRepo(r.name))}
        values={matrix.values} cellSize={28} cellWidth={96} gap={3} maxHeight={480}
        scaleMax={measure === "share" ? 1 : undefined} legendFormatter={measure === "share" ? share : full}
        headerTooltip={(axis, index) => axis === "row" ? {
          heading: matrix.people[index].author,
          rows: [{ label: "lines across selected repositories", value: full(matrix.people[index].lines) }],
        } : {
          heading: matrix.repos[index].name,
          rows: [{ label: "surviving lines", value: full(matrix.repos[index].totalLines) }, { label: "top owner", value: matrix.repos[index].topAuthor }],
        }}
        cellTooltip={(_, row, col) => ({
          heading: `${matrix.people[row].author} · ${matrix.repos[col].name}`,
          rows: [{ label: "credited lines", value: full(matrix.cellAt(row, col)?.lines ?? 0) }, { label: "of this repository", value: share(matrix.cellAt(row, col)?.share ?? 0) }],
        })} />
    </ChartCard>
  </>;
}
