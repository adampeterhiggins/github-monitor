import clsx from "clsx";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { usePageBusy, type PageBusy } from "../lib/hooks";
import { Spinner } from "./ui";

interface PageBusyContextValue extends PageBusy {
  setExtraPending: (id: string, pending: boolean) => void;
}

const PageBusyContext = createContext<PageBusyContextValue | null>(null);

/**
 * One loading signal for the whole window: filter catch-up, in-flight page
 * queries, and any page that has registered deferred chart work.
 */
export function PageBusyProvider({ children }: { children: ReactNode }) {
  const extras = useRef(new Map<string, boolean>());
  const [extraPending, setExtraPendingState] = useState(false);

  const setExtraPending = useCallback((id: string, pending: boolean) => {
    extras.current.set(id, pending);
    const next = [...extras.current.values()].some(Boolean);
    setExtraPendingState((prev) => (prev === next ? prev : next));
  }, []);

  const busy = usePageBusy(extraPending);
  const value = useMemo(() => ({ ...busy, setExtraPending }), [busy, setExtraPending]);

  return <PageBusyContext.Provider value={value}>{children}</PageBusyContext.Provider>;
}

export function usePageBusyState(): PageBusy {
  const ctx = useContext(PageBusyContext);
  return ctx ?? { catchingUp: false, fetching: false, busy: false, label: "Loading…" };
}

/**
 * Tell the shared loading chrome that this page's charts have not caught up
 * with a control that updates immediately (popover options, sliders).
 */
export function useViewPending(id: string, pending: boolean) {
  const setExtraPending = useContext(PageBusyContext)?.setExtraPending;
  useEffect(() => {
    if (!setExtraPending) return;
    setExtraPending(id, pending);
    return () => setExtraPending(id, false);
  }, [id, pending, setExtraPending]);
}

/** Thin indeterminate bar across the top of the main pane. */
export function PageBusyBar() {
  const { busy, label } = usePageBusyState();
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {busy ? label : ""}
      </div>
      {busy ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-[50] h-0.5 overflow-hidden bg-wash-strong"
          aria-hidden="true"
        >
          <div className="page-busy-indeterminate h-full bg-accent" />
        </div>
      ) : null}
    </>
  );
}

/** Spinner + copy in the filter row, beside the date range. */
export function PageBusyStatus() {
  const { busy, label } = usePageBusyState();
  if (!busy) return null;
  return (
    <span
      aria-hidden="true"
      className="flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary"
    >
      <Spinner size={12} />
      {label}
    </span>
  );
}

/** Marks the scrollable page body as busy without dimming expanded charts. */
export function PageBusyFrame({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const { busy } = usePageBusyState();
  return (
    <div
      className={clsx("relative", className)}
      aria-busy={busy || undefined}
      style={busy ? { ...style, cursor: "progress" } : style}
    >
      {children}
      {busy ? (
        <div
          className="pointer-events-none absolute inset-0 z-[5]"
          aria-hidden="true"
          style={{ background: "color-mix(in srgb, var(--page-plane) 38%, transparent)" }}
        />
      ) : null}
    </div>
  );
}
