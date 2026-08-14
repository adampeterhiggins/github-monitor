import clsx from "clsx";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

/* ── Formatting ─────────────────────────────────────────────────────────── */

const COMPACT = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });
const FULL = new Intl.NumberFormat("en-GB");

/** Big standalone figures compact; anything in a column stays exact. */
export function compact(n: number): string {
  return Math.abs(n) >= 10_000 ? COMPACT.format(n) : FULL.format(n);
}

export function full(n: number): string {
  return FULL.format(n);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/* ── Card ───────────────────────────────────────────────────────────────── */

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={clsx(
        "rounded-lg border border-hairline bg-surface",
        padded && "p-4",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  subtitle,
  titleAfter,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Controls that read as part of the title, on the title's own line. */
  titleAfter?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-3 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[15px] font-semibold leading-tight text-ink">{title}</h2>
          {titleAfter ? (
            <div className="flex shrink-0 items-center gap-1">{titleAfter}</div>
          ) : null}
        </div>
        {subtitle ? <p className="mt-0.5 text-[12px] text-ink-secondary">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}

/* ── Button ─────────────────────────────────────────────────────────────── */

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  className?: string;
};

export function Button({
  children,
  onClick,
  variant = "default",
  size = "sm",
  disabled,
  title,
  type = "button",
  className,
}: ButtonProps) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-9 px-3.5 text-[13px]",
        variant === "default" &&
          "border border-hairline-strong bg-surface text-ink hover:bg-wash",
        variant === "primary" && "bg-accent text-accent-ink hover:opacity-90",
        variant === "ghost" && "text-ink-secondary hover:bg-wash hover:text-ink",
        variant === "danger" && "border border-hairline-strong text-critical hover:bg-wash",
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ── Segmented control ──────────────────────────────────────────────────── */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  /** Fill the available width, splitting it evenly — for stacked popover rows. */
  stretch,
  /** `bare` drops the border, for use inside an already-bordered row. */
  variant = "outlined",
}: {
  value: T;
  /** An option can be disabled on its own, for a choice that does not apply. */
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  stretch?: boolean;
  variant?: "outlined" | "bare";
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={clsx(
        "rounded-md p-0.5",
        stretch ? "flex w-full" : "inline-flex",
        variant === "outlined" && "border border-hairline-strong",
        disabled && "opacity-50",
      )}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          role="tab"
          aria-selected={value === opt.value}
          disabled={disabled || opt.disabled}
          onClick={() => onChange(opt.value)}
          className={clsx(
            "rounded px-2 py-1 text-[12px] font-medium transition-colors",
            "disabled:cursor-not-allowed",
            stretch && "min-w-0 flex-1 truncate",
            opt.disabled && "opacity-50",
            value === opt.value
              ? "bg-wash-strong text-ink"
              : "text-ink-secondary enabled:hover:text-ink",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Label chip plus a control, so stacked rows in a popover line up. */
export function LabeledControl({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-8 items-stretch overflow-hidden rounded-md border border-hairline-strong">
      <span className="flex w-[68px] shrink-0 items-center bg-wash px-2 text-[12px] font-medium text-ink-secondary">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center px-0.5">{children}</div>
    </div>
  );
}

/** Compact range control for a labelled popover row. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  ariaLabel,
  format = String,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  format?: (value: number) => string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
      <input
        type="range"
        className="slider min-w-0 flex-1"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-8 shrink-0 text-right text-[11px] tabular text-ink-secondary">
        {format(value)}
      </span>
    </div>
  );
}

/* ── Dropdown (presets as rows, selection marked with a check) ───────────── */

const PANEL =
  "absolute z-50 mt-1 rounded-lg border border-hairline-strong bg-surface shadow-lg";

/** Closes on a click outside or on Escape. Returns the ref to put on the root. */
function useDismissable(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  return ref;
}

export function Dropdown({
  label,
  children,
  align = "right",
  width = 240,
}: {
  label: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "left" | "right";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable(open, close);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className={clsx(
          "inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline-strong",
          "bg-surface px-2.5 text-[12px] font-medium text-ink hover:bg-wash",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        )}
      >
        {label}
        <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 8l3-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open ? (
        <div
          style={{ width }}
          className={clsx(PANEL, "overflow-hidden", align === "right" ? "right-0" : "left-0")}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}

export function DropdownRow({
  selected,
  onClick,
  disabled,
  children,
}: {
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-ink",
        disabled ? "cursor-not-allowed opacity-50" : "hover:bg-wash",
      )}
    >
      <span className="w-4 shrink-0 text-[16px] font-bold leading-none text-ink">
        {selected ? "✓" : ""}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/* ── View selector ──────────────────────────────────────────────────────────
   One control for the primary way of reading a chart: step through views with
   the arrows, or pick one from the dropdown. Sits beside the chart title so the
   heading says what is on screen, and keeps the header down to two controls
   rather than a row of five.                                                 */

export function ViewSelector<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  /** Noun for the "2 of 4" dropdown header. Left off by default. */
  countLabel,
  /** Left/right arrow keys step the view, for charts that own the page. */
  keyboardNav = false,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  countLabel?: string;
  keyboardNav?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable(open, close);

  const index = options.findIndex((o) => o.value === value);
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < options.length - 1;

  useEffect(() => {
    if (!keyboardNav) return;
    const onKey = (e: KeyboardEvent) => {
      // Never steal the arrow keys from something being typed in.
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.closest("input, textarea, select") !== null || target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "ArrowLeft" && hasPrev) {
        e.preventDefault();
        onChange(options[index - 1].value);
      } else if (e.key === "ArrowRight" && hasNext) {
        e.preventDefault();
        onChange(options[index + 1].value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboardNav, options, index, hasPrev, hasNext, onChange]);

  // Nothing to switch between.
  if (options.length <= 1) return null;

  return (
    <div className="flex items-center gap-0.5" ref={ref}>
      <Arrow
        dir="left"
        label={`Previous ${ariaLabel}`}
        disabled={!hasPrev}
        onClick={() => onChange(options[index - 1].value)}
      />
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="true"
          aria-label={ariaLabel}
          className={clsx(
            "rounded-md bg-wash px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-wash-strong",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          )}
        >
          {/* All labels stacked in one cell, so the pill is as wide as the
              longest of them and does not resize as views change. */}
          <span className="grid place-items-center">
            {options.map((o) => (
              <span
                key={o.value}
                aria-hidden={o.value !== value}
                className={clsx(
                  "col-start-1 row-start-1 whitespace-nowrap",
                  o.value !== value && "invisible",
                )}
              >
                {o.label}
              </span>
            ))}
          </span>
        </button>
        {open ? (
          <div className={clsx(PANEL, "left-0 w-auto min-w-[160px] overflow-hidden")}>
            <div className="px-2.5 pt-1.5 text-[11px] font-medium text-ink-muted">
              {index + 1} of {options.length}
              {countLabel ? ` ${countLabel}` : ""}
            </div>
            <div className="py-1">
              {options.map((o) => (
                <DropdownRow
                  key={o.value}
                  selected={o.value === value}
                  onClick={() => {
                    onChange(o.value);
                    close();
                  }}
                >
                  {o.label}
                </DropdownRow>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <Arrow
        dir="right"
        label={`Next ${ariaLabel}`}
        disabled={!hasNext}
        onClick={() => onChange(options[index + 1].value)}
      />
    </div>
  );
}

function Arrow({
  dir,
  label,
  disabled,
  onClick,
}: {
  dir: "left" | "right";
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex h-5 w-5 items-center justify-center rounded text-ink-muted",
        disabled ? "cursor-not-allowed opacity-30" : "hover:text-ink",
      )}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path
          d={dir === "left" ? "M7.5 2 4 6l3.5 4" : "M4.5 2 8 6l-3.5 4"}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/* ── Filter popover ─────────────────────────────────────────────────────────
   The rest of the chart's controls, behind one icon. The dot marks a view that
   differs from the default, so a filtered chart never looks like a plain one. */

export function FilterPopover({
  children,
  active,
  label = "Chart options",
  align = "left",
  width = 300,
}: {
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Shows the marker dot — set when anything is off its default. */
  active?: boolean;
  label?: string;
  align?: "left" | "right";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable(open, close);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={label}
        title={label}
        className={clsx(
          "relative flex h-7 w-7 items-center justify-center rounded-md hover:bg-wash",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          active ? "text-accent" : "text-ink-secondary hover:text-ink",
        )}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18" />
            <path d="M7 12h10" />
            <path d="M10 18h4" />
          </g>
        </svg>
        {active ? (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
        ) : null}
      </button>
      {open ? (
        <div
          style={{ width }}
          className={clsx(
            PANEL,
            "flex flex-col gap-2 p-2",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}

/* ── Checkbox ───────────────────────────────────────────────────────────── */

export function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate === true && !checked;
  }, [indeterminate, checked]);

  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-[12px] text-ink">
      <input
        id={id}
        ref={ref}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
      />
      <span className="min-w-0 truncate">{label}</span>
    </label>
  );
}

/* ── Stat tile ──────────────────────────────────────────────────────────── */

export function StatTile({
  label,
  value,
  delta,
  hint,
  trend,
}: {
  label: string;
  value: string | number;
  /** Signed change vs the comparison period, plus whether up is good. */
  delta?: { value: number; upIsGood?: boolean; period?: string };
  hint?: string;
  trend?: ReactNode;
}) {
  const d = delta;
  const positive = d ? d.value > 0 : false;
  const good = d ? (d.upIsGood === false ? !positive : positive) : false;

  return (
    <div className="rounded-lg border border-hairline bg-surface p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        {/* Proportional figures: tabular-nums makes display sizes look loose. */}
        <span className="text-[24px] font-semibold leading-none text-ink">
          {typeof value === "number" ? compact(value) : value}
        </span>
        {d && d.value !== 0 ? (
          <span
            className="text-[12px] font-medium"
            style={{ color: good ? "var(--delta-up)" : "var(--delta-down)" }}
          >
            {positive ? "▲" : "▼"} {compact(Math.abs(d.value))}
            {d.period ? <span className="text-ink-muted"> vs {d.period}</span> : null}
          </span>
        ) : null}
      </div>
      {trend ? <div className="mt-2 h-8">{trend}</div> : null}
      {hint ? <div className="mt-1.5 text-[11px] text-ink-secondary">{hint}</div> : null}
    </div>
  );
}

/* ── Table ──────────────────────────────────────────────────────────────── */

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  width?: string;
  render: (row: T) => ReactNode;
  /** Sort value; omit to make the column unsortable. */
  sortValue?: (row: T) => number | string;
}

export function DataTable<T>({
  rows,
  columns,
  empty = "No data",
  maxHeight,
  initialSort,
  rowKey,
}: {
  rows: T[];
  columns: Array<Column<T>>;
  empty?: string;
  maxHeight?: number;
  initialSort?: { key: string; dir: "asc" | "desc" };
  rowKey: (row: T, index: number) => string | number;
}) {
  const [sort, setSort] = useState(initialSort ?? null);

  const sorted = (() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
      return String(av).localeCompare(String(bv)) * factor;
    });
  })();

  if (rows.length === 0) {
    return <p className="py-6 text-center text-[12px] text-ink-secondary">{empty}</p>;
  }

  return (
    <div className="overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className={clsx(
                  "border-b border-hairline px-2 py-1.5 font-medium text-ink-secondary",
                  c.align === "right" ? "text-right" : "text-left",
                  c.sortValue && "cursor-pointer select-none hover:text-ink",
                )}
                onClick={
                  c.sortValue
                    ? () =>
                        setSort((s) =>
                          s?.key === c.key
                            ? { key: c.key, dir: s.dir === "desc" ? "asc" : "desc" }
                            : { key: c.key, dir: "desc" },
                        )
                    : undefined
                }
              >
                {c.header}
                {sort?.key === c.key ? (sort.dir === "desc" ? " ↓" : " ↑") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={rowKey(row, i)} className="hover:bg-wash">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={clsx(
                    "border-b border-hairline px-2 py-1.5 text-ink",
                    c.align === "right" ? "text-right tabular" : "text-left",
                  )}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── States ─────────────────────────────────────────────────────────────── */

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-hairline-strong px-6 py-12 text-center">
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {body ? <p className="max-w-md text-[12px] leading-relaxed text-ink-secondary">{body}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="animate-spin"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Callout({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "critical";
  children: ReactNode;
}) {
  const color =
    tone === "warning" ? "var(--status-warning)" : tone === "critical" ? "var(--status-critical)" : "var(--accent)";
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-hairline bg-surface px-3 py-2 text-[12px] leading-relaxed text-ink-secondary"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      {/* Status never rides on color alone — the icon plus the text carries it. */}
      <span aria-hidden="true" style={{ color }} className="mt-px shrink-0 font-bold">
        {tone === "info" ? "i" : "!"}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * Icon-only trigger for a menu of actions.
 *
 * Distinct from `Dropdown`, which names its current value on the button — there is
 * nothing to name here, only things to do, so the trigger is the conventional
 * kebab and the panel holds `DropdownRow` actions.
 */
export function MenuButton({
  children,
  label = "More",
  align = "right",
  width = 240,
}: {
  children: ReactNode | ((close: () => void) => ReactNode);
  label?: string;
  align?: "left" | "right";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable(open, close);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={clsx(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
          "text-ink-secondary hover:bg-wash hover:text-ink",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          open && "bg-wash text-ink",
        )}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>
      {open ? (
        <div
          style={{ width }}
          className={clsx(PANEL, "overflow-hidden", align === "right" ? "right-0" : "left-0")}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}

/* ── Expanding a chart ──────────────────────────────────────────────────────
   A card is a good size for scanning and a poor one for reading a dense weekly
   series, so any chart can be opened over the whole window.

   Charts are authored at the height that suits their card, and the pages placing
   them have no idea when one is being shown expanded. Rather than thread a height
   through every call site, a chart rendered inside `ChartHeight` takes its height
   from there — which is what lets the expanded view fill the window without any
   page knowing about it.                                                       */

const HeightContext = createContext<number | null>(null);

export function ChartHeight({ value, children }: { value: number; children: ReactNode }) {
  return <HeightContext.Provider value={value}>{children}</HeightContext.Provider>;
}

/** Null unless a `ChartHeight` above asked for a specific height. */
export const useChartHeight = () => useContext(HeightContext);

/**
 * The page's filter row, offered to whatever might want to repeat it.
 *
 * An expanded chart covers the page, filters included, and the scope those
 * filters set is most of what the chart means — so it carries a copy rather than
 * making you close the chart to change the period. Passed as an element through
 * context so no page has to know that expanding exists.
 */
const PageFiltersContext = createContext<ReactNode>(null);

export function PageFilters({ value, children }: { value: ReactNode; children: ReactNode }) {
  return <PageFiltersContext.Provider value={value}>{children}</PageFiltersContext.Provider>;
}

export function ExpandButton({
  onClick,
  label = "Expand",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={clsx(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
        "text-ink-secondary hover:bg-wash hover:text-ink",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      )}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 3h6v6" />
          <path d="M9 21H3v-6" />
          <path d="M21 3l-7 7" />
          <path d="M3 21l7-7" />
        </g>
      </svg>
    </button>
  );
}

/**
 * A chart shown over the whole window.
 *
 * `children` is called with the height left for the body, so the chart inside can
 * take the room rather than staying at its card size. Escape and a click on the
 * backdrop both close it, since a full-screen view with one way out is a trap.
 */
export function Modal({
  title,
  subtitle,
  titleAfter,
  actions,
  onClose,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  titleAfter?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: (bodyHeight: number) => ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  const filters = useContext(PageFiltersContext);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Measured rather than derived from the viewport, so the chart still fits when
  // the header wraps to two lines or the window is resized under it.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setBodyHeight(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex flex-col backdrop-blur-sm"
      // The plane the cards sit on, held back so the page reads as still there.
      style={{ background: "color-mix(in srgb, var(--page-plane) 75%, transparent)" }}
    >
      {/* Full bleed across the top, where it sits on the page itself. */}
      {filters}

      {/* The click-to-close target is the margin around the card, so a stray click
          in the filter row above changes nothing. */}
      <div
        className="flex min-h-0 flex-1 flex-col p-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <Card className="flex min-h-0 flex-1 flex-col shadow-lg">
          <CardHeader
            title={title}
            subtitle={subtitle}
            titleAfter={titleAfter}
            actions={
              <>
                {actions}
                <Button variant="ghost" onClick={onClose} title="Close (Esc)">
                  Close
                </Button>
              </>
            }
          />
          {/* Charts carry a legend under them, so the height offered leaves room
              for one; a legend long enough to need more than that scrolls. */}
          <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto overscroll-contain">
            {bodyHeight > 0 ? children(Math.max(200, bodyHeight - 52)) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ── Chart / table view toggle ──────────────────────────────────────────────
   The light palette has three slots below 3:1 contrast, which the validator
   flags as requiring a relief channel. Every chart therefore ships a table view
   so no value is reachable only by distinguishing two similar fills.          */

const ViewContext = createContext<"chart" | "table">("chart");
export const useChartView = () => useContext(ViewContext);

export function ChartCard({
  title,
  subtitle,
  titleAfter,
  actions,
  children,
  table,
  className,
  /** Held at reduced opacity during a refetch so the frame never jumps. */
  loading,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  titleAfter?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  table?: ReactNode;
  className?: string;
  loading?: boolean;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const [expanded, setExpanded] = useState(false);

  // The same controls in both places, so expanding does not take anything away.
  const controls = (
    <>
      {actions}
      {table ? (
        <Segmented
          ariaLabel="View as"
          value={view}
          onChange={setView}
          options={[
            { value: "chart", label: "Chart" },
            { value: "table", label: "Table" },
          ]}
        />
      ) : null}
    </>
  );

  const body = view === "chart" || !table ? children : table;

  return (
    <>
      <Card className={className}>
        <CardHeader
          title={title}
          subtitle={subtitle}
          titleAfter={titleAfter}
          actions={
            <>
              {controls}
              <ExpandButton onClick={() => setExpanded(true)} />
            </>
          }
        />
        <ViewContext.Provider value={view}>
          <div className={clsx("transition-opacity", loading && "opacity-60")}>{body}</div>
        </ViewContext.Provider>
      </Card>

      {/* Outside the card, so the dimming during a refetch does not apply to it. */}
      {expanded ? (
        <Modal
          title={title}
          subtitle={subtitle}
          titleAfter={titleAfter}
          actions={controls}
          onClose={() => setExpanded(false)}
        >
          {(height) => (
            <ViewContext.Provider value={view}>
              {view === "chart" || !table ? (
                <ChartHeight value={height}>{children}</ChartHeight>
              ) : (
                <div className="h-full overflow-auto">{table}</div>
              )}
            </ViewContext.Provider>
          )}
        </Modal>
      ) : null}
    </>
  );
}
