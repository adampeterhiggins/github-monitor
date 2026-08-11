import clsx from "clsx";
import {
  createContext,
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
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-3 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold leading-tight text-ink">{title}</h2>
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
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-hairline-strong p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          role="tab"
          aria-selected={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={clsx(
            "rounded px-2 py-1 text-[12px] font-medium transition-colors",
            value === opt.value
              ? "bg-wash-strong text-ink"
              : "text-ink-secondary hover:text-ink",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ── Dropdown (presets as rows, selection marked with a check) ───────────── */

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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

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
          className={clsx(
            "absolute z-50 mt-1 overflow-hidden rounded-lg border border-hairline-strong bg-surface shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
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
  children,
}: {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-wash"
    >
      <span className="w-4 shrink-0 text-[16px] font-bold leading-none text-ink">
        {selected ? "✓" : ""}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
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

/* ── Chart / table view toggle ──────────────────────────────────────────────
   The light palette has three slots below 3:1 contrast, which the validator
   flags as requiring a relief channel. Every chart therefore ships a table view
   so no value is reachable only by distinguishing two similar fills.          */

const ViewContext = createContext<"chart" | "table">("chart");
export const useChartView = () => useContext(ViewContext);

export function ChartCard({
  title,
  subtitle,
  actions,
  children,
  table,
  className,
  /** Held at reduced opacity during a refetch so the frame never jumps. */
  loading,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  table?: ReactNode;
  className?: string;
  loading?: boolean;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");

  return (
    <Card className={className}>
      <CardHeader
        title={title}
        subtitle={subtitle}
        actions={
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
        }
      />
      <ViewContext.Provider value={view}>
        <div className={clsx("transition-opacity", loading && "opacity-60")}>
          {view === "chart" || !table ? children : table}
        </div>
      </ViewContext.Provider>
    </Card>
  );
}
