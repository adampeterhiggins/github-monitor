import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useApp } from "../lib/state/app";
import {
  METRICS,
  metricCanBeNegative,
  metricLabel,
  metricValue,
  type ContributionMetric,
} from "../lib/agg/metrics";
import { useScope, useScopedQuery } from "../lib/hooks";
import {
  contributorRepoBreakdown,
  contributorRepoIds,
  contributorWeekBounds,
  contributorWeeklyByLogin,
  contributorRepoWeeklyAll,
  contributorWeeklyTotals,
  listContributorMeta,
  weeklyByRepo,
  type ContributorWeekRow,
} from "../lib/db/queries";
import { buildStacks } from "../lib/agg/stacks";
import {
  bucketLabel,
  chartBounds,
  rollUp,
  toCumulative,
  weekWindow,
  type Granularity,
} from "../lib/agg/series";
import { WEEK_SECONDS, axisWeeksFor, formatDate, weekSpan } from "../lib/agg/weeks";
import { PageShell } from "../components/PageShell";
import { Sparkline, TimelineArea, type TimelineShape } from "../components/charts";
import {
  Button,
  ChartCard,
  ChartHeight,
  Card,
  Checkbox,
  DataTable,
  Dropdown,
  DropdownRow,
  EmptyState,
  ExpandButton,
  FilterPopover,
  LabeledControl,
  MenuButton,
  Modal,
  Segmented,
  compact,
  full,
} from "../components/ui";

type Breakdown = "none" | "contributor" | "repository";

/**
 * How the timeline reads time: a running total, or per bucket of a given size.
 * One axis rather than two controls, because "cumulative monthly" and
 * "cumulative weekly" draw the same curve — only the point density differs.
 */
type TimelineView = "cumulative" | Granularity;

/* Module-level so the timeline row is not rebuilt on every render. */

const TIMELINE_VIEWS: Array<{ value: TimelineView; label: string }> = [
  { value: "cumulative", label: "Cumulative" },
  { value: "week", label: "Per week" },
  { value: "month", label: "Per month" },
  { value: "quarter", label: "Per quarter" },
];

const SHAPES: Array<{ value: TimelineShape; label: string }> = [
  { value: "bar", label: "Bars" },
  { value: "area", label: "Area" },
  { value: "line", label: "Line" },
];

const BREAKDOWNS: Array<{ value: Breakdown; label: string }> = [
  { value: "none", label: "None" },
  { value: "contributor", label: "Contributor" },
  { value: "repository", label: "Repository" },
];

type StackMode = "stacked" | "overlaid";
type ValueMode = "total" | "share";

const STACKINGS: Array<{ value: StackMode; label: string }> = [
  { value: "stacked", label: "Stacked" },
  { value: "overlaid", label: "Overlaid" },
];

/**
 * What the axis measures, which is a separate question from how the series share
 * the plot: stacked shares show composition, overlaid shares show whose share is
 * largest at a given point without adding bands up by eye.
 */
const VALUE_MODES: Array<{ value: ValueMode; label: string }> = [
  { value: "total", label: "Totals" },
  { value: "share", label: "Share" },
];

const SCALES: Array<{ value: "shared" | "own"; label: string }> = [
  { value: "shared", label: "Shared scale" },
  { value: "own", label: "Own scale" },
];

/** The same two, for the label chip in a popover where "scale" is already said. */
const SCALES_SHORT: Array<{ value: "shared" | "own"; label: string }> = [
  { value: "shared", label: "Shared" },
  { value: "own", label: "Own" },
];

const Y_AXES: Array<{ value: "full" | "fit"; label: string }> = [
  { value: "full", label: "Full" },
  { value: "fit", label: "Fit to data" },
];

const CARD_SPLITS: Array<{ value: "none" | "repository"; label: string }> = [
  { value: "none", label: "Total" },
  { value: "repository", label: "By repository" },
];

/**
 * How many entities a breakdown draws separately before the tail becomes "Other".
 *
 * The palette has eight categorical slots and the eighth is the last one with a
 * validated hue, so eight is the honest default. "All" is offered anyway, because
 * a chart of forty repositories is a fair thing to want to see in full — past the
 * eighth the hues repeat, which the option says so you can decide whether that
 * trade is worth it here.
 */
const SERIES_LIMITS: Array<{ value: string; label: string }> = [
  { value: "4", label: "4" },
  { value: "6", label: "6" },
  { value: "8", label: "8" },
  { value: "all", label: "All" },
];

/** Remember a view choice: how you read the data, not a transient action. */
function persist<T>(key: string, value: T, set: (v: T) => void) {
  localStorage.setItem(key, String(value));
  set(value);
}

/**
 * The series and rows one contributor card draws: its repository split when that
 * is on, otherwise a single series, put through the same roll-up and running
 * total as the org chart so the cards and the headline never describe time
 * differently.
 *
 * `keys` comes back with it because the caller needs the series keys to measure
 * how tall each row draws, and re-deriving them is how they drift.
 */
function buildCardChart(
  card: ContributorCard,
  repoStack: ReturnType<typeof buildStacks> | null,
  metric: ContributionMetric,
  granularity: Granularity,
  cumulative: boolean,
) {
  const series = repoStack
    ? repoStack.series.map((sr) => ({ key: sr.key, label: sr.label, slot: sr.slot }))
    : [{ key: "value", label: metric, slot: 0 }];
  const keys = series.map((sr) => sr.key);
  const base: Array<Record<string, number>> = repoStack
    ? repoStack.data
    : card.weeks.map((w) => ({ week: w.week, value: w.value }));
  const rolled = rollUp(base, keys, granularity);
  return {
    series,
    keys,
    split: repoStack !== null,
    data: cumulative ? toCumulative(rolled, keys) : rolled,
  };
}

interface ContributorCard {
  login: string;
  avatar: string | null;
  url: string | null;
  commits: number;
  additions: number;
  deletions: number;
  /** Derived, not stored — see `metricValue`. Held here so `card[metric]` works. */
  net: number;
  weeks: Array<{ week: number; value: number }>;
}

export function Contributors() {
  const scope = useScope();
  const metric = useApp((s) => s.metric);
  const setMetric = useApp((s) => s.setMetric);
  const setPeriod = useApp((s) => s.setPeriod);
  const setSelectedRepos = useApp((s) => s.setSelectedRepos);
  const repos = useApp((s) => s.repos);
  const [limit, setLimit] = useState(24);
  /** How the org-wide chart is split. */
  const [breakdown, setBreakdown] = useState<Breakdown>("none");

  /**
   * Timeline view state. Persisted, because these are a way of reading the data
   * rather than a transient action, and re-choosing them on every visit is a chore.
   */
  const [shape, setShape] = useState<TimelineShape>(
    () => (localStorage.getItem("github-monitor.shape") as TimelineShape) || "bar",
  );
  /**
   * How several series share the plot, and what the axis measures.
   *
   * Both read through the settings they replaced, so an existing preference
   * survives: "normalised" used to be a third stacking option, and before that
   * stacking was a boolean.
   */
  const [stackMode, setStackMode] = useState<StackMode>(() => {
    const stored = localStorage.getItem("github-monitor.stackMode");
    if (stored === "overlaid") return "overlaid";
    if (stored === "stacked" || stored === "normalised") return "stacked";
    return localStorage.getItem("github-monitor.stacked") === "false" ? "overlaid" : "stacked";
  });
  const [valueMode, setValueMode] = useState<ValueMode>(() => {
    const stored = localStorage.getItem("github-monitor.valueMode") as ValueMode | null;
    if (stored) return stored;
    // The old three-way control called stacked shares "normalised". Written through
    // straight away: changing the stacking overwrites the key this reads, so a
    // migration left until later would lose the preference it was migrating.
    const migrated = localStorage.getItem("github-monitor.stackMode") === "normalised";
    localStorage.setItem("github-monitor.valueMode", migrated ? "share" : "total");
    return migrated ? "share" : "total";
  });
  const [view, setView] = useState<TimelineView>(() =>
    localStorage.getItem("github-monitor.cumulative") === "true"
      ? "cumulative"
      : (localStorage.getItem("github-monitor.granularity") as Granularity) || "week",
  );
  /** Stretch the y axis to the data rather than starting at zero or 0–100%. */
  const [yAxis, setYAxis] = useState<"full" | "fit">(
    () => (localStorage.getItem("github-monitor.yAxis") === "fit" ? "fit" : "full"),
  );
  /** Leave the folded Other band undrawn; it still counts in every share and total. */
  const [hideOther, setHideOther] = useState(() => localStorage.getItem("github-monitor.hideOther") === "true");
  /** Series switched off via the legend. Empty means everything is shown. */
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());

  /** How many series a breakdown draws before folding the rest into "Other". */
  const [seriesLimit, setSeriesLimit] = useState<string>(
    () => localStorage.getItem("github-monitor.seriesLimit") || "8",
  );
  const maxSeries = seriesLimit === "all" ? Number.POSITIVE_INFINITY : Number(seriesLimit);

  /** Net lines can be negative, which several defaults here assume away. */
  const signedMetric = metricCanBeNegative(metric);

  const cumulative = view === "cumulative";
  // A running total is the same curve at any bucket size, so it reads the raw
  // weekly series — which also keeps the brush, since that needs weeks.
  const granularity: Granularity = cumulative ? "week" : view;

  /** Stable across renders of the options panel. */
  const chooseView = useCallback((v: TimelineView) => {
    localStorage.setItem("github-monitor.cumulative", String(v === "cumulative"));
    if (v !== "cumulative") localStorage.setItem("github-monitor.granularity", v);
    setView(v);
  }, []);

  /** How every contributor card is split. One control for all of them. */
  const [cardSplit, setCardSplit] = useState<"none" | "repository">(
    () => (localStorage.getItem("github-monitor.cardSplit") as "none" | "repository") || "none",
  );
  const setSplit = (mode: "none" | "repository") => {
    localStorage.setItem("github-monitor.cardSplit", mode);
    setCardSplit(mode);
  };

  /**
   * Whether the cards share one y scale. On by default: self-scaled small
   * multiples make a contributor with 20 commits draw the same picture as one
   * with 2,000. Off is still worth having — a shared ceiling flattens the long
   * tail, and reading the shape of one quiet contributor's year is a fair thing
   * to want.
   */
  const [sharedScale, setSharedScale] = useState(
    () => localStorage.getItem("github-monitor.cardScale") !== "own",
  );

  /**
   * Whether every card shows its repository breakdown. One control rather than one
   * per card: comparing where two people's commits went meant opening each of them
   * in turn, and the answer was never on screen at the same time.
   *
   * Not persisted, unlike the other card controls — each open card runs its own
   * query, so this is not a state to restore two dozen of on every visit.
   */
  const [showNumbers, setShowNumbers] = useState(false);

  const totals = useScopedQuery("contrib-totals", scope, (db) =>
    contributorWeeklyTotals(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek, scope.logins),
  );

  const perLogin = useScopedQuery("contrib-by-login", scope, (db) =>
    contributorWeeklyByLogin(
      db,
      scope.repoIds,
      scope.range.fromWeek,
      scope.range.toWeek,
      scope.logins,
    ),
  );

  const meta = useScopedQuery("contrib-meta", scope, (db) => listContributorMeta(db), {
    staleTime: 10 * 60_000,
  });

  /**
   * Each contributor's whole span, for the card action that jumps the period to it.
   * Unbounded by the period on screen, which is the point of it.
   */
  const extents = useScopedQuery(
    "contrib-extents",
    scope,
    (db) => contributorWeekBounds(db, scope.repoIds),
    { staleTime: 5 * 60_000 },
  );

  /**
   * Which repositories each contributor has touched, for the card action that
   * selects them. Unscoped by design — see `contributorRepoIds`.
   */
  const contributorRepos = useScopedQuery(
    "contrib-repo-ids",
    scope,
    (db) => contributorRepoIds(db),
    { staleTime: 5 * 60_000 },
  );

  const reposByLogin = useMemo(() => {
    const out = new Map<string, number[]>();
    for (const row of contributorRepos.data ?? []) {
      const key = row.login.toLowerCase();
      const list = out.get(key);
      if (list) list.push(Number(row.repo_id));
      else out.set(key, [Number(row.repo_id)]);
    }
    return out;
  }, [contributorRepos.data]);

  const spanByLogin = useMemo(() => {
    const out = new Map<string, { from: number; to: number }>();
    for (const row of extents.data ?? []) {
      const span = weekSpan({ firstWeek: Number(row.first_week), lastWeek: Number(row.last_week) });
      if (span) out.set(row.login.toLowerCase(), span);
    }
    return out;
  }, [extents.data]);

  // One query for every card's repository split, fetched only when it is on.
  const cardRepoWeekly = useScopedQuery(
    "contrib-card-repo-weekly",
    scope,
    (db) =>
      contributorRepoWeeklyAll(
        db,
        scope.repoIds,
        scope.range.fromWeek,
        scope.range.toWeek,
        scope.logins,
      ),
    { enabled: scope.ready && cardSplit === "repository" },
  );

  // Only fetched when the repository breakdown is on — it is a bigger result than
  // the plain totals and most views never need it.
  const byRepoWeekly = useScopedQuery(
    "contrib-by-repo-weekly",
    scope,
    (db) =>
      weeklyByRepo(db, scope.repoIds, scope.range.fromWeek, scope.range.toWeek, scope.logins),
    { enabled: scope.ready && breakdown === "repository" },
  );

  const selectedRepoCount = scope.repoIds.length;

  /** Every week in range, clamped to where data starts so "All time" stays sane. */
  const axisWeeks = useMemo(
    () =>
      axisWeeksFor(
        scope.range.fromWeek,
        scope.range.toWeek,
        (totals.data ?? []).map((r) => r.week),
      ),
    [scope.range.fromWeek, scope.range.toWeek, totals.data],
  );

  const masterSeries = useMemo(() => {
    const byWeek = new Map(totals.data?.map((r) => [r.week, r]) ?? []);
    return axisWeeks.map((week) => ({
      week,
      value: metricValue(byWeek.get(week), metric),
    }));
  }, [totals.data, axisWeeks, metric]);

  /**
   * The brushed window, as indices into `axisWeeks`.
   *
   * Debounced: the brush fires continuously while dragging, and with "All time"
   * spanning thousands of weeks, recomputing every card on each event makes the
   * drag stutter.
   */
  const [brush, setBrush] = useState<{ start: number; end: number } | null>(null);
  const [pendingBrush, setPendingBrush] = useState<{ start: number; end: number } | null>(null);

  useEffect(() => {
    if (pendingBrush === null) return;
    const t = setTimeout(() => setBrush(pendingBrush), 60);
    return () => clearTimeout(t);
  }, [pendingBrush]);

  // A new period or repo selection changes the axis, so old indices are meaningless.
  useEffect(() => {
    setBrush(null);
    setPendingBrush(null);
  }, [scope.key]);

  /** Weeks the cards should cover: the brushed window, or the whole range. */
  const visibleWeeks = useMemo(() => {
    if (!brush || axisWeeks.length === 0) return axisWeeks;
    const last = axisWeeks.length - 1;
    const start = Math.max(0, Math.min(brush.start, last));
    const end = Math.max(start, Math.min(brush.end, last));
    return axisWeeks.slice(start, end + 1);
  }, [axisWeeks, brush]);

  const zoomed = visibleWeeks.length > 0 && visibleWeeks.length !== axisWeeks.length;

  /**
   * login -> week -> row. Built from the query result alone so that brushing does
   * not redo it; only the windowed slice below re-runs on a drag.
   */
  const byLogin = useMemo(() => {
    const out = new Map<string, Map<number, ContributorWeekRow>>();
    for (const row of perLogin.data ?? []) {
      let m = out.get(row.login);
      if (!m) {
        m = new Map();
        out.set(row.login, m);
      }
      m.set(row.week, row);
    }
    return out;
  }, [perLogin.data]);

  const cards = useMemo(() => {
    const metaByLogin = new Map(meta.data?.map((m) => [m.login, m]) ?? []);
    const out: ContributorCard[] = [];

    for (const [login, weeksByNumber] of byLogin) {
      let commits = 0;
      let additions = 0;
      let deletions = 0;
      const weeks: Array<{ week: number; value: number }> = [];

      // Totals are summed over the visible window too, so the figures on a card
      // always describe the chart beside them — which is what makes brushing
      // useful rather than confusing.
      for (const week of visibleWeeks) {
        const row = weeksByNumber.get(week);
        commits += Number(row?.commits ?? 0);
        additions += Number(row?.additions ?? 0);
        deletions += Number(row?.deletions ?? 0);
        weeks.push({ week, value: metricValue(row, metric) });
      }

      out.push({
        login,
        avatar: metaByLogin.get(login)?.avatar_url ?? null,
        url: metaByLogin.get(login)?.html_url ?? null,
        commits,
        additions,
        deletions,
        net: additions - deletions,
        weeks,
      });
    }

    /* Rank by the selected contribution type, as the repo-level page does, so the
       order changes with the window — which is the point. Cards are dropped only
       when the metric is actually nothing: net is signed, and a contributor who
       removed more than they added is not an absence. */
    return out.filter((c) => c[metric] !== 0).sort((a, b) => b[metric] - a[metric]);
  }, [byLogin, meta.data, visibleWeeks, metric]);

  /**
   * The org-wide chart, split by contributor or repository.
   *
   * Both are derived from data already loaded for the cards where possible — the
   * contributor split reuses `perLogin` rather than issuing a second query.
   */
  const orgStack = useMemo(() => {
    if (breakdown === "contributor") {
      return buildStacks({
        rows: perLogin.data ?? [],
        weeks: visibleWeeks,
        weekOf: (r) => r.week,
        keyOf: (r) => r.login.toLowerCase(),
        labelOf: (r) => r.login,
        valueOf: (r) => metricValue(r, metric),
        rankBy: signedMetric ? Math.abs : undefined,
        maxSeries,
      });
    }
    if (breakdown === "repository") {
      return buildStacks({
        rows: byRepoWeekly.data ?? [],
        weeks: visibleWeeks,
        weekOf: (r) => r.week,
        keyOf: (r) => String(r.repo_id),
        labelOf: (r) => r.full_name.split("/").pop() ?? r.full_name,
        valueOf: (r) => metricValue(r, metric),
        rankBy: signedMetric ? Math.abs : undefined,
        maxSeries,
      });
    }
    return null;
  }, [breakdown, perLogin.data, byRepoWeekly.data, visibleWeeks, metric, signedMetric, maxSeries]);

  /**
   * One dataset for the org chart whichever view is selected: the breakdown when
   * there is one, otherwise a single total series. Rolled up and accumulated last,
   * so those two controls compose with every breakdown rather than each view
   * needing its own path.
   */
  const orgChart = useMemo(() => {
    const series = orgStack
      ? orgStack.series.map((sr) => ({ key: sr.key, label: sr.label, slot: sr.slot }))
      : [{ key: "total", label: metricLabel(metric), slot: 0 }];

    const base: Array<Record<string, number>> = orgStack
      ? orgStack.data
      : masterSeries.map((d) => ({ week: d.week, total: d.value }));

    const keys = series.map((sr) => sr.key);
    const rolled = rollUp(base, keys, granularity);
    return { series, data: cumulative ? toCumulative(rolled, keys) : rolled };
  }, [orgStack, masterSeries, metric, granularity, cumulative]);

  /**
   * The brush reports positions in the buckets the chart drew, which are weeks
   * only in the per-week views, so the window is resolved by time rather than by
   * index — see `weekWindow`.
   */
  const handleBrush = useCallback(
    (startIndex: number, endIndex: number) => {
      const window = weekWindow(orgChart.data, axisWeeks, startIndex, endIndex);
      if (window) setPendingBrush(window);
    },
    [orgChart.data, axisWeeks],
  );

  /**
   * Keep the legend selection to series that still exist.
   *
   * A selection is a set of keys, and every control on the page can change which
   * keys there are — a different breakdown, a lower limit folding the tail into
   * "Other", a narrower repository or period selection dropping someone from the
   * data entirely. A key left behind is unreachable: it is not in the legend, so
   * there is nothing to click to remove it, and until it goes the chart counts
   * itself filtered and dims everything that is still there.
   *
   * Pruning is enough on its own — no separate reset. Emptying the set is exactly
   * what "the thing you had selected is gone" should mean, and a metric change,
   * which leaves the keys alone, now keeps your selection rather than dropping it.
   */
  const seriesKeys = useMemo(() => orgChart.series.map((sr) => sr.key), [orgChart.series]);

  useEffect(() => {
    setActiveKeys((prev) => {
      if (prev.size === 0) return prev;
      const present = new Set(seriesKeys);
      const next = new Set([...prev].filter((k) => present.has(k)));
      // Same identity when nothing was stale, or this would re-render forever.
      return next.size === prev.size ? prev : next;
    });
  }, [seriesKeys]);

  /**
   * Legend selection: the first click isolates, later clicks build a set.
   *
   * From nothing selected, clicking picks that one series out — which is what you
   * want nine times in ten, and the reason it is not "hide the thing I clicked".
   * After that a click adds an unselected series or removes a selected one, and
   * emptying the set returns to everything, the state it started in.
   */
  const toggleKey = (key: string) =>
    setActiveKeys((prev) => {
      if (prev.size === 0) return new Set([key]);
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /**
   * login -> stacked-by-repository series, built once for every card rather than
   * per card. Keyed lowercase to match the merged identities.
   */
  const cardStacks = useMemo(() => {
    if (cardSplit !== "repository") return null;
    const rowsByLogin = new Map<string, typeof cardRepoWeekly.data>();
    for (const row of cardRepoWeekly.data ?? []) {
      const key = row.login.toLowerCase();
      const list = rowsByLogin.get(key);
      if (list) list.push(row);
      else rowsByLogin.set(key, [row]);
    }
    const out = new Map<string, ReturnType<typeof buildStacks>>();
    for (const [login, rows] of rowsByLogin) {
      out.set(
        login,
        buildStacks({
          rows: rows ?? [],
          weeks: visibleWeeks,
          weekOf: (r) => r.week,
          keyOf: (r) => String(r.repo_id),
          labelOf: (r) => r.full_name.split("/").pop() ?? r.full_name,
          valueOf: (r) => metricValue(r, metric),
          rankBy: signedMetric ? Math.abs : undefined,
          maxSeries,
        }),
      );
    }
    return out;
  }, [cardSplit, cardRepoWeekly.data, visibleWeeks, metric, signedMetric, maxSeries]);

  /**
   * Every visible card's chart, plus the bounds that fit all of them.
   *
   * Built here rather than inside the cards because a shared scale has to cover
   * what they actually draw: the roll-up sums weeks into bigger buckets and the
   * running total climbs the whole way, so bounds taken from raw weekly values
   * would clip the tallest card in most views.
   *
   * The floor is only ever below zero for net lines, and it has to be — an axis
   * that starts at zero draws a week that deleted 5,000 lines as nothing at all.
   */
  const cardCharts = useMemo(() => {
    const visible = cards.slice(0, limit);
    const charts = visible.map((c) =>
      buildCardChart(
        c,
        cardStacks?.get(c.login.toLowerCase()) ?? null,
        metric,
        granularity,
        cumulative,
      ),
    );

    return {
      byLogin: new Map(visible.map((c, i) => [c.login, charts[i]])),
      ...chartBounds(charts, stackMode !== "overlaid"),
    };
  }, [cards, limit, cardStacks, metric, granularity, cumulative, stackMode]);

  /**
   * Whether anything behind the filter button is off its default. Marks the
   * button, so a chart split by contributor never looks like a plain total.
   * Stacking is not counted on its own: it only takes effect with a breakdown,
   * which is flagged anyway.
   */
  const viewChanged = breakdown !== "none" || shape !== "bar" || view !== "week" || yAxis !== "full" || hideOther;

  /**
   * The controls a contributor card carries when it is opened full screen.
   *
   * The cards follow the page's timeline view, so this is the headline chart's
   * options with its breakdown swapped for the two that belong to the
   * cards — how each one is split, and whether they share a scale. Cheap to build
   * once here and hand to every card: only the open one ever renders it.
   */
  const cardControls = (
    <FilterPopover active={shape !== "bar" || cardSplit !== "none" || view !== "week" || yAxis !== "full" || hideOther} width={420}>
        <Segmented<TimelineView>
          ariaLabel="Timeline"
          stretch
          value={view}
          onChange={chooseView}
          options={TIMELINE_VIEWS}
        />
        <Segmented<TimelineShape>
          ariaLabel="Chart shape"
          stretch
          value={shape}
          onChange={(v) => persist("github-monitor.shape", v, setShape)}
          options={SHAPES}
        />
        <LabeledControl label="Split by">
          <Segmented
            ariaLabel="Split contributor charts"
            variant="bare"
            stretch
            value={cardSplit}
            onChange={setSplit}
            options={CARD_SPLITS}
          />
        </LabeledControl>
        <LabeledControl label="Show">
          <Segmented
            ariaLabel="Series before Other"
            variant="bare"
            stretch
            value={seriesLimit}
            onChange={(v) => persist("github-monitor.seriesLimit", v, setSeriesLimit)}
            options={SERIES_LIMITS}
          />
        </LabeledControl>
        <Checkbox
          checked={hideOther}
          disabled={seriesLimit === "all" || cardSplit === "none"}
          onChange={(v: boolean) => persist("github-monitor.hideOther", v, setHideOther)}
          label={<span className="text-ink-secondary" title="Other stays in every share and total; it is only not drawn">Hide Other</span>}
        />
        {seriesLimit === "all" ? (
          <p className="px-0.5 text-[11px] text-ink-muted">
            Past eight series the colours repeat — the legend and tooltip still name
            each one.
          </p>
        ) : null}
        <Segmented
          ariaLabel="Stacking"
          stretch
          // Here it is the card's own split that decides whether stacking means
          // anything, not the headline chart's breakdown.
          disabled={cardSplit === "none"}
          value={stackMode}
          onChange={(v) => persist("github-monitor.stackMode", v, setStackMode)}
          options={STACKINGS}
        />
        <Segmented<ValueMode>
          ariaLabel="Values"
          stretch
          // A share of one series is always 100%, so this needs something to split.
          disabled={cardSplit === "none"}
          value={valueMode}
          onChange={(v) => persist("github-monitor.valueMode", v, setValueMode)}
          options={VALUE_MODES}
        />
        <LabeledControl label="Scale">
          <Segmented
            ariaLabel="Card y-axis scale"
            variant="bare"
            stretch
            value={sharedScale ? "shared" : "own"}
            onChange={(v) =>
              persist("github-monitor.cardScale", v, (mode) => setSharedScale(mode === "shared"))
            }
            options={SCALES_SHORT}
          />
        </LabeledControl>
        <LabeledControl label="Y axis">
          <Segmented
            ariaLabel="Card y axis range"
            variant="bare"
            stretch
            value={yAxis}
            onChange={(v) => persist("github-monitor.yAxis", v, setYAxis)}
            options={Y_AXES}
          />
        </LabeledControl>
        {sharedScale && yAxis === "fit" ? (
          <p className="px-0.5 text-[11px] text-ink-muted">
            Cards on a shared scale keep one ceiling so they compare; choose Own to fit each card.
          </p>
        ) : null}
    </FilterPopover>
  );

  const grandTotal = cards.reduce((a, c) => a + c[metric], 0);
  const valueLabel = metricLabel(metric).toLowerCase();
  const loading = totals.isFetching || perLogin.isFetching;

  return (
    <PageShell
      title="Contributors"
      userFilter="full"
      subtitle={
        <>
          Contributions per week across{" "}
          <strong className="font-medium text-ink">{full(selectedRepoCount)}</strong>{" "}
          {selectedRepoCount === 1 ? "repository" : "repositories"}, excluding merge commits
          {scope.filteredByUser ? (
            <> — filtered to {full(scope.logins?.length ?? 0)} selected contributors</>
          ) : null}
        </>
      }
      filterExtra={
        <Dropdown label={`Contributions: ${metricLabel(metric)}`} width={180} align="left">
          {(close) => (
            <div className="py-1">
              {METRICS.map((m) => (
                <DropdownRow
                  key={m.id}
                  selected={m.id === metric}
                  onClick={() => {
                    setMetric(m.id);
                    close();
                  }}
                >
                  {m.label}
                </DropdownRow>
              ))}
            </div>
          )}
        </Dropdown>
      }
    >
      <div className="flex flex-col gap-4">
        <ChartCard
          title={`${metricLabel(metric)} over time`}
          subtitle={
            zoomed
              ? `Weekly from ${formatDate(visibleWeeks[0] * 1000)} to ${formatDate(
                  visibleWeeks[visibleWeeks.length - 1] * 1000 + WEEK_SECONDS * 1000 - 1,
                )} — drag the handles below to change the window`
              : `Weekly from ${formatDate(scope.range.fromWeek * 1000)} to ${formatDate(
                  scope.range.toWeek * 1000 + WEEK_SECONDS * 1000 - 1,
                )}`
          }
          loading={loading}
          titleAfter={
              <FilterPopover active={viewChanged} width={420}>
                <Segmented<TimelineView>
                  ariaLabel="Timeline"
                  stretch
                  value={view}
                  onChange={chooseView}
                  options={TIMELINE_VIEWS}
                />
                <Segmented<TimelineShape>
                  ariaLabel="Chart shape"
                  stretch
                  value={shape}
                  onChange={(v) => persist("github-monitor.shape", v, setShape)}
                  options={SHAPES}
                />
                <LabeledControl label="Split by">
                  <Segmented<Breakdown>
                    ariaLabel="Break down"
                    variant="bare"
                    stretch
                    value={breakdown}
                    onChange={setBreakdown}
                    options={BREAKDOWNS}
                  />
                </LabeledControl>
                <LabeledControl label="Show">
                  <Segmented
                    ariaLabel="Series before Other"
                    variant="bare"
                    stretch
                    value={seriesLimit}
                    onChange={(v) => persist("github-monitor.seriesLimit", v, setSeriesLimit)}
                    options={SERIES_LIMITS}
                  />
                </LabeledControl>
                <Checkbox
                  checked={hideOther}
                  disabled={seriesLimit === "all" || breakdown === "none"}
                  onChange={(v: boolean) => persist("github-monitor.hideOther", v, setHideOther)}
                  label={<span className="text-ink-secondary" title="Other stays in every share and total; it is only not drawn">Hide Other</span>}
                />
                {seriesLimit === "all" ? (
                  <p className="px-0.5 text-[11px] text-ink-muted">
                    Past eight series the colours repeat — the legend and tooltip still name
                    each one.
                  </p>
                ) : null}
                <Segmented
                  ariaLabel="Stacking"
                  stretch
                  // Nothing to stack without a breakdown, but hiding the control
                  // would make the popover jump as the breakdown changes.
                  disabled={breakdown === "none"}
                  value={stackMode}
                  onChange={(v) => persist("github-monitor.stackMode", v, setStackMode)}
                  options={STACKINGS}
                />
                <Segmented<ValueMode>
                  ariaLabel="Values"
                  stretch
                  // A share of one series is always 100%, so this needs a breakdown.
                  disabled={breakdown === "none"}
                  value={valueMode}
                  onChange={(v) => persist("github-monitor.valueMode", v, setValueMode)}
                  options={VALUE_MODES}
                />
                <LabeledControl label="Y axis">
                  <Segmented
                    ariaLabel="Y axis range"
                    variant="bare"
                    stretch
                    value={yAxis}
                    onChange={(v) => persist("github-monitor.yAxis", v, setYAxis)}
                    options={Y_AXES}
                  />
                </LabeledControl>
              </FilterPopover>
          }
          actions={
            <>
              {zoomed ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setBrush(null);
                    setPendingBrush(null);
                  }}
                  title="Show the whole period again"
                >
                  Reset zoom
                </Button>
              ) : null}
              <span className="mr-1 text-[12px] tabular text-ink-secondary">
                {full(grandTotal)} total
              </span>
            </>
          }
          table={
            <DataTable
              rows={
                // Empty weeks are dropped, but a negative net week is not empty.
                masterSeries.filter((d) => d.value !== 0)
              }
              maxHeight={320}
              rowKey={(r) => r.week}
              initialSort={{ key: "week", dir: "desc" }}
              columns={[
                {
                  key: "week",
                  header: "Week of",
                  render: (r) => formatDate(r.week * 1000),
                  sortValue: (r) => r.week,
                },
                {
                  key: "value",
                  header: metricLabel(metric),
                  align: "right",
                  render: (r) => full(r.value),
                  sortValue: (r) => r.value,
                },
              ]}
            />
          }
        >
          <TimelineArea
            data={orgChart.data}
            series={orgChart.series}
            shape={shape}
            stackMode={stackMode}
            values={valueMode}
            height={260}
            valueLabel={valueLabel}
            labelOf={(week) => bucketLabel(week, granularity)}
            activeKeys={activeKeys}
            onToggleKey={toggleKey}
            withBrush
            onBrushChange={(r) => handleBrush(r.startIndex, r.endIndex)}
            yFit={yAxis === "fit"}
            hideOther={hideOther}
          />

        </ChartCard>

        {cards.length === 0 ? (
          <EmptyState
            title="No contributions in this period"
            body="Try a longer period, or widen the repository selection."
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12px] text-ink-secondary">
                {zoomed
                  ? `Cards cover the selected window (${full(visibleWeeks.length)} week${
                      visibleWeeks.length === 1 ? "" : "s"
                    }), so totals and ranking change with it.`
                  : "Cards cover the whole period."}
                {cardSplit === "repository" && cardRepoWeekly.isFetching ? " Loading splits…" : ""}
              </p>
              <div className="flex items-center gap-1.5">
                <Segmented
                  ariaLabel="Card y-axis scale"
                  value={sharedScale ? "shared" : "own"}
                  onChange={(v) =>
                    persist("github-monitor.cardScale", v, (mode) =>
                      setSharedScale(mode === "shared"),
                    )
                  }
                  options={SCALES}
                />
                <Segmented
                  ariaLabel="Split contributor charts"
                  value={cardSplit}
                  onChange={setSplit}
                  options={CARD_SPLITS}
                />
                <Button
                  variant={showNumbers ? "primary" : "default"}
                  onClick={() => setShowNumbers((v) => !v)}
                  title="Show the repository breakdown under every chart"
                >
                  {showNumbers ? "Hide numbers" : "Numbers"}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {cards.slice(0, limit).map((c, i) => (
                <ContributorCardView
                  key={c.login}
                  card={c}
                  rank={i + 1}
                  metric={metric}
                  chart={cardCharts.byLogin.get(c.login)!}
                  yMax={sharedScale ? cardCharts.ceiling : undefined}
                  yMin={sharedScale ? cardCharts.floor : undefined}
                  repoCount={repos.length}
                  view={{ shape, stackMode, valueMode, granularity, yFit: yAxis === "fit" && !sharedScale, hideOther }}
                  controls={cardControls}
                  showNumbers={showNumbers}
                  span={spanByLogin.get(c.login.toLowerCase()) ?? null}
                  theirRepoIds={reposByLogin.get(c.login.toLowerCase()) ?? []}
                  onSetPeriod={setPeriod}
                  onSelectRepos={setSelectedRepos}
                />
              ))}
            </div>

            {cards.length > limit ? (
              <div className="flex items-center justify-center gap-3">
                <span className="text-[12px] text-ink-secondary">
                  Showing {full(limit)} of {full(cards.length)} contributors
                </span>
                <Button onClick={() => setLimit((l) => l + 24)}>Show more</Button>
                <Button variant="ghost" onClick={() => setLimit(cards.length)}>
                  Show all
                </Button>
              </div>
            ) : null}

            <Card>
              <h2 className="mb-2 text-[15px] font-semibold text-ink">All contributors</h2>
              <DataTable
                rows={cards}
                maxHeight={420}
                rowKey={(r) => r.login}
                initialSort={{ key: metric, dir: "desc" }}
                columns={[
                  {
                    key: "login",
                    header: "Contributor",
                    render: (r) => r.login,
                    sortValue: (r) => r.login,
                  },
                  {
                    key: "commits",
                    header: "Commits",
                    align: "right",
                    render: (r) => full(r.commits),
                    sortValue: (r) => r.commits,
                  },
                  {
                    key: "additions",
                    header: "Additions",
                    align: "right",
                    render: (r) => full(r.additions),
                    sortValue: (r) => r.additions,
                  },
                  {
                    key: "deletions",
                    header: "Deletions",
                    align: "right",
                    render: (r) => full(r.deletions),
                    sortValue: (r) => r.deletions,
                  },
                  {
                    key: "net",
                    header: "Net lines",
                    align: "right",
                    // Signed, and carrying the direction in ink as well as the sign
                    // so it does not rest on colour alone.
                    render: (r) => (
                      <span
                        style={{
                          color: r.net >= 0 ? "var(--delta-up)" : "var(--delta-down)",
                        }}
                      >
                        {r.net >= 0 ? "+" : "−"}
                        {full(Math.abs(r.net))}
                      </span>
                    ),
                    sortValue: (r) => r.net,
                  },
                ]}
              />
            </Card>
          </>
        )}
      </div>
    </PageShell>
  );
}

function ContributorCardView({
  card,
  rank,
  metric,
  chart,
  yMax,
  yMin,
  repoCount,
  view,
  controls,
  showNumbers,
  span,
  theirRepoIds,
  onSetPeriod,
  onSelectRepos,
}: {
  card: ContributorCard;
  rank: number;
  metric: ContributionMetric;
  /** Prepared by the page, which needs every card's rows to size a shared scale. */
  chart: ReturnType<typeof buildCardChart>;
  /** A shared ceiling across the cards, or undefined to self-scale. */
  yMax?: number;
  /** The matching floor, below zero only where the metric goes there. */
  yMin?: number;
  repoCount: number;
  /** The shared timeline view, so cards and the org chart never disagree. */
  view: {
    shape: TimelineShape;
    stackMode: StackMode;
    valueMode: ValueMode;
    granularity: Granularity;
    /** Only on an own-scale card: a shared ceiling is what makes cards comparable. */
    yFit: boolean;
    hideOther: boolean;
  };
  /** Shown when the card is opened full screen, where the page's own are hidden. */
  controls: ReactNode;
  /** Set for every card at once, from the control above the grid. */
  showNumbers: boolean;
  /** The period covering this person's whole history, or null if they have none. */
  span: { from: number; to: number } | null;
  /** Every repository they have commits in, across the cache rather than the selection. */
  theirRepoIds: number[];
  onSetPeriod: (period: "custom", custom: { from: number; to: number }) => void;
  onSelectRepos: (ids: number[]) => Promise<void> | void;
}) {
  const scope = useScope();
  const [expanded, setExpanded] = useState(false);

  const breakdown = useScopedQuery(
    `contrib-repos-${card.login}`,
    scope,
    (db) =>
      contributorRepoBreakdown(db, card.login, scope.repoIds, scope.range.fromWeek, scope.range.toWeek),
    { enabled: scope.ready && showNumbers },
  );

  const menu = (
    <MenuButton label={`Options for ${card.login}`} width={268}>
      {(close) => (
        <div className="py-1">
          <DropdownRow
            disabled={span == null}
            onClick={() => {
              if (!span) return;
              onSetPeriod("custom", span);
              close();
            }}
          >
            <span className="block truncate">Set period to all their commits</span>
            <span className="block truncate text-[11px] text-ink-muted">
              {span ? `${formatDate(span.from)} – ${formatDate(span.to)}` : "No commits cached"}
            </span>
          </DropdownRow>

          <DropdownRow
            disabled={theirRepoIds.length === 0}
            onClick={() => {
              if (theirRepoIds.length === 0) return;
              void onSelectRepos(theirRepoIds);
              close();
            }}
          >
            <span className="block truncate">Select all their repositories</span>
            <span className="block truncate text-[11px] text-ink-muted">
              {theirRepoIds.length > 0
                ? `${full(theirRepoIds.length)} ${
                    theirRepoIds.length === 1 ? "repository" : "repositories"
                  } with their commits`
                : "No repositories cached"}
            </span>
          </DropdownRow>
        </div>
      )}
    </MenuButton>
  );

  /* One element for both places: shown expanded, `ChartHeight` overrides the
     height it was authored at, so there is nothing to keep in step. */
  const graph =
    view.shape === "bar" && !chart.split ? (
      // The plain bar sparkline stays for the unbroken case: it is denser and
      // needs no legend, which matters at two dozen cards on screen.
      <Sparkline
        data={chart.data as Array<{ week: number; value: number }>}
        metricLabel={metric}
        yMax={yMax}
        yMin={yMin}
        height={72}
      />
    ) : (
      <TimelineArea
        data={chart.data}
        series={chart.series}
        shape={view.shape}
        stackMode={view.stackMode}
        values={view.valueMode}
        height={96}
        valueLabel={metric}
        labelOf={(week) => bucketLabel(week, view.granularity)}
        yMax={yMax}
        yMin={yMin}
        yFit={view.yFit}
        hideOther={view.hideOther}
      />
    );

  return (
    <Card>
      <div className="mb-2 flex items-start gap-2.5">
        {card.avatar ? (
          <img
            src={card.avatar}
            alt=""
            width={32}
            height={32}
            className="mt-0.5 shrink-0 rounded-full"
            loading="lazy"
          />
        ) : (
          <div className="mt-0.5 h-8 w-8 shrink-0 rounded-full" style={{ background: "var(--wash-strong)" }} />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <a
              href={card.url ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="truncate text-[13px] font-semibold text-accent hover:underline"
            >
              {card.login}
            </a>
            <span className="shrink-0 rounded border border-hairline-strong px-1 text-[10px] tabular text-ink-muted">
              #{rank}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[12px] tabular">
            <span className="text-ink">{full(card.commits)} commits</span>
            {/* Delta cues wear status ink and are labelled, never color alone. */}
            <span style={{ color: "var(--delta-up)" }}>{full(card.additions)} ++</span>
            <span style={{ color: "var(--delta-down)" }}>{full(card.deletions)} --</span>
          </div>
        </div>

        <ExpandButton onClick={() => setExpanded(true)} label={`Expand ${card.login}`} />

        {menu}
      </div>

      {graph}

      {expanded ? (
        <Modal
          title={card.login}
          subtitle={`#${rank} · ${full(card.commits)} commits, ${full(card.additions)} added and ${full(
            card.deletions,
          )} deleted`}
          titleAfter={
            <>
              {controls}
              {menu}
            </>
          }
          onClose={() => setExpanded(false)}
        >
          {(height) => <ChartHeight value={height}>{graph}</ChartHeight>}
        </Modal>
      ) : null}

      {showNumbers ? (
        <div className="mt-3 border-t border-hairline pt-2">
          <DataTable
            rows={breakdown.data ?? []}
            maxHeight={180}
            empty={breakdown.isFetching ? "Loading…" : "No commits in the selected repositories"}
            rowKey={(r) => r.full_name}
            columns={[
              {
                key: "repo",
                header: `Repository (of ${full(repoCount)})`,
                render: (r) => r.full_name,
              },
              {
                key: "commits",
                header: "Commits",
                align: "right",
                render: (r) => compact(Number(r.commits)),
                sortValue: (r) => Number(r.commits),
              },
              {
                key: "net",
                header: "Net lines",
                align: "right",
                render: (r) => {
                  const net = Number(r.additions) - Number(r.deletions);
                  return (
                    <span style={{ color: net >= 0 ? "var(--delta-up)" : "var(--delta-down)" }}>
                      {net >= 0 ? "+" : "−"}
                      {compact(Math.abs(net))}
                    </span>
                  );
                },
                sortValue: (r) => Number(r.additions) - Number(r.deletions),
              },
            ]}
          />
        </div>
      ) : null}
    </Card>
  );
}
