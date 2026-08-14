import { useEffect, useMemo, useState } from "react";
import { useScope, useScopedQuery } from "../lib/hooks";
import {
  contributorRepoBreakdown,
  contributorWeekBounds,
  contributorWeeklyByLogin,
  listContributorMeta,
  listContributors,
  mergedPrDurations,
  pulseAuthors,
} from "../lib/db/queries";
import { PERIODS, formatDate, weekToDate } from "../lib/agg/weeks";
import { useApp } from "../lib/state/app";
import { PageShell } from "../components/PageShell";
import { RankedBars, WeeklyColumns } from "../components/charts";
import {
  Callout,
  Card,
  ChartCard,
  DataTable,
  EmptyState,
  StatTile,
  full,
} from "../components/ui";

function hoursLabel(h: number): string {
  if (h <= 0) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function People() {
  const scope = useScope();
  const period = useApp((s) => s.period);
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? "the selected period";

  const people = useScopedQuery("people-list", scope, (db) =>
    listContributors(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek),
  );
  const meta = useScopedQuery("people-meta", scope, (db) => listContributorMeta(db));
  const bounds = useScopedQuery("people-bounds", scope, (db) =>
    contributorWeekBounds(db, scope.repoIds),
  );

  const listed = useMemo(() => {
    const all = people.data ?? [];
    if (!scope.logins) return all;
    const wanted = new Set(scope.logins.map((l) => l.toLowerCase()));
    return all.filter((p) => wanted.has(p.login.toLowerCase()));
  }, [people.data, scope.logins]);

  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (listed.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((current) => {
      if (current && listed.some((p) => p.login.toLowerCase() === current.toLowerCase())) {
        return current;
      }
      return listed[0].login;
    });
  }, [listed]);

  const person = listed.find((p) => p.login.toLowerCase() === selected?.toLowerCase()) ?? null;
  const login = person?.login ?? null;
  const personMeta = (meta.data ?? []).find(
    (m) => login != null && m.login.toLowerCase() === login.toLowerCase(),
  );
  const span = (bounds.data ?? []).find(
    (b) => login != null && b.login.toLowerCase() === login.toLowerCase(),
  );

  const weekly = useScopedQuery(
    "people-weekly",
    scope,
    (db) =>
      contributorWeeklyByLogin(
        db,
        scope.repoIds,
        scope.range.fromWeek,
        scope.range.toWeek,
        login ? [login] : null,
      ),
    { enabled: login != null },
  );

  const repos = useScopedQuery(
    "people-repos",
    scope,
    (db) =>
      contributorRepoBreakdown(
        db,
        login!,
        scope.repoIds,
        scope.range.fromWeek,
        scope.range.toWeek,
      ),
    { enabled: login != null },
  );

  const durations = useScopedQuery(
    "people-durations",
    scope,
    (db) => mergedPrDurations(db, scope.repoIds, scope.fromIso, scope.toIso, login ? [login] : null),
    { enabled: login != null },
  );

  const authors = useScopedQuery(
    "people-prs",
    scope,
    (db) => pulseAuthors(db, scope.repoIds, scope.fromIso, scope.toIso, login ? [login] : null),
    { enabled: login != null },
  );

  const weekSeries = useMemo(
    () => (weekly.data ?? []).map((r) => ({ week: r.week, value: Number(r.commits) })),
    [weekly.data],
  );

  const leadTimes = useMemo(
    () => (durations.data ?? []).map((d) => Number(d.hours)).filter((h) => Number.isFinite(h) && h >= 0),
    [durations.data],
  );

  const prs = authors.data?.[0];

  return (
    <PageShell
      title="People"
      subtitle={`One person across the selected repositories — ${periodLabel.toLowerCase()}`}
      userFilter="full"
    >
      <Callout>
        GitHub's profile is one person across all of GitHub. This page is one
        person across <em>this</em> organisation: the repositories they touch,
        the shape of their weeks, and how long their pull requests take to merge.
        The contributor filter narrows the list; with one person selected it
        opens on them.
      </Callout>

      {listed.length === 0 ? (
        <EmptyState
          title="No contributors in this selection"
          body="Pick repositories that have commits, or clear the contributor filter."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[240px_minmax(0,1fr)]">
          <Card padded={false}>
            <div className="border-b border-hairline px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
              {full(listed.length)} {listed.length === 1 ? "person" : "people"}
            </div>
            <ul className="max-h-[640px] overflow-y-auto">
              {listed.map((p) => {
                const active = p.login.toLowerCase() === login?.toLowerCase();
                return (
                  <li key={p.login}>
                    <button
                      type="button"
                      onClick={() => setSelected(p.login)}
                      aria-current={active ? "true" : undefined}
                      className={
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors " +
                        (active
                          ? "bg-wash-strong font-medium text-ink"
                          : "text-ink-secondary hover:bg-wash hover:text-ink")
                      }
                    >
                      {p.avatar_url ? (
                        <img
                          src={p.avatar_url}
                          alt=""
                          width={22}
                          height={22}
                          className="shrink-0 rounded-full"
                          loading="lazy"
                        />
                      ) : (
                        <span
                          className="h-[22px] w-[22px] shrink-0 rounded-full"
                          style={{ background: "var(--wash-strong)" }}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{p.login}</span>
                      <span className="shrink-0 tabular text-[11px] text-ink-muted">
                        {full(Number(p.commits))}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {person ? (
            <div className="flex flex-col gap-4">
              <Card>
                <div className="flex items-start gap-3">
                  {person.avatar_url ? (
                    <img
                      src={person.avatar_url}
                      alt=""
                      width={44}
                      height={44}
                      className="shrink-0 rounded-full"
                    />
                  ) : (
                    <div
                      className="h-11 w-11 shrink-0 rounded-full"
                      style={{ background: "var(--wash-strong)" }}
                    />
                  )}
                  <div className="min-w-0">
                    <a
                      href={person.html_url ?? personMeta?.html_url ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[16px] font-semibold text-accent hover:underline"
                    >
                      {person.login}
                    </a>
                    <p className="mt-0.5 text-[12px] text-ink-secondary">
                      {span
                        ? `First commit week of ${formatDate(weekToDate(Number(span.first_week)))} · last ${formatDate(
                            weekToDate(Number(span.last_week)),
                          )}`
                        : "No commit span in the selected repositories"}
                      {personMeta?.type ? ` · ${personMeta.type}` : ""}
                    </p>
                  </div>
                </div>
              </Card>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile
                  label="Commits"
                  value={Number(person.commits)}
                  hint={`${full(Number(person.commits_all))} all time in these repos`}
                />
                <StatTile label="Repositories" value={Number(person.repos)} hint="Touched in the period" />
                <StatTile
                  label="Lines added"
                  value={Number(person.additions)}
                  hint={`${full(Number(person.deletions))} deleted`}
                />
                <StatTile
                  label="Median time to merge"
                  value={hoursLabel(percentile(leadTimes, 0.5))}
                  hint={
                    prs
                      ? `${full(Number(prs.prs_merged))} merged · ${full(Number(prs.prs_opened))} opened`
                      : "No merged pull requests"
                  }
                />
              </div>

              <ChartCard
                title="Commits by week"
                subtitle="In the selected repositories and period"
                loading={weekly.isFetching}
                table={
                  <DataTable
                    rows={weekly.data ?? []}
                    maxHeight={280}
                    rowKey={(r) => r.week}
                    initialSort={{ key: "week", dir: "desc" }}
                    columns={[
                      {
                        key: "week",
                        header: "Week",
                        render: (r) => formatDate(weekToDate(r.week)),
                        sortValue: (r) => r.week,
                      },
                      {
                        key: "commits",
                        header: "Commits",
                        align: "right",
                        render: (r) => full(Number(r.commits)),
                        sortValue: (r) => Number(r.commits),
                      },
                      {
                        key: "additions",
                        header: "Additions",
                        align: "right",
                        render: (r) => full(Number(r.additions)),
                        sortValue: (r) => Number(r.additions),
                      },
                      {
                        key: "deletions",
                        header: "Deletions",
                        align: "right",
                        render: (r) => full(Number(r.deletions)),
                        sortValue: (r) => Number(r.deletions),
                      },
                    ]}
                  />
                }
              >
                <WeeklyColumns data={weekSeries} metricLabel="commits" height={220} />
              </ChartCard>

              <ChartCard
                title="Repositories"
                subtitle="Where their commits landed in the period"
                loading={repos.isFetching}
                table={
                  <DataTable
                    rows={repos.data ?? []}
                    maxHeight={280}
                    rowKey={(r) => r.full_name}
                    initialSort={{ key: "commits", dir: "desc" }}
                    columns={[
                      {
                        key: "repo",
                        header: "Repository",
                        render: (r) => r.full_name,
                        sortValue: (r) => r.full_name,
                      },
                      {
                        key: "commits",
                        header: "Commits",
                        align: "right",
                        render: (r) => full(Number(r.commits)),
                        sortValue: (r) => Number(r.commits),
                      },
                      {
                        key: "additions",
                        header: "Additions",
                        align: "right",
                        render: (r) => full(Number(r.additions)),
                        sortValue: (r) => Number(r.additions),
                      },
                      {
                        key: "deletions",
                        header: "Deletions",
                        align: "right",
                        render: (r) => full(Number(r.deletions)),
                        sortValue: (r) => Number(r.deletions),
                      },
                    ]}
                  />
                }
              >
                <RankedBars
                  valueLabel="commits"
                  data={(repos.data ?? []).slice(0, 12).map((r) => ({
                    name: r.full_name.split("/").pop() ?? r.full_name,
                    value: Number(r.commits),
                  }))}
                />
              </ChartCard>
            </div>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}
