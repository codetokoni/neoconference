"use client";

// src/app/admin/ui.tsx — the admin area's shared pieces: page header,
// panels, buttons, notices, loading / empty / error states, a dialog shell
// (focus kept inside, Escape closes the top one, focus goes back to where it
// was), the confirmation step for sensitive actions, stat tiles that open the
// list behind the figure, tabs, sortable tables with a pager, and filters
// kept in the address bar so a view can be linked.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400";

export const btn = {
  primary: `inline-flex items-center justify-center rounded-lg bg-cyan-500 px-3.5 py-2 text-sm font-semibold text-black transition hover:bg-cyan-400 disabled:opacity-40 ${focusRing}`,
  ghost: `inline-flex items-center justify-center rounded-lg border border-white/12 px-3 py-1.5 text-sm text-zinc-200 transition hover:bg-white/5 disabled:opacity-40 ${focusRing}`,
  danger: `inline-flex items-center justify-center rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-200 transition hover:bg-red-500/20 disabled:opacity-40 ${focusRing}`,
  warn: `inline-flex items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-40 ${focusRing}`,
};

export const field =
  "w-full rounded-lg border border-white/12 bg-black/40 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-cyan-400/70 focus-visible:ring-2 focus-visible:ring-cyan-400/50";

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-cyan-50">{title}</h1>
        {sub && <p className="mt-1 max-w-2xl text-sm text-zinc-400">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-white/10 bg-white/[0.03] p-4 ${className}`}>{children}</section>;
}

export function Badge({ tone = "zinc", children }: { tone?: "zinc" | "cyan" | "amber" | "red" | "green"; children: ReactNode }) {
  const tones = {
    zinc: "bg-white/5 text-zinc-300",
    cyan: "bg-cyan-400/10 text-cyan-300",
    amber: "bg-amber-400/15 text-amber-300",
    red: "bg-red-500/15 text-red-300",
    green: "bg-emerald-500/15 text-emerald-300",
  };
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function Notice({ kind, children, onClose, onRetry }: { kind: "ok" | "err" | "info"; children: ReactNode; onClose?: () => void; onRetry?: () => void }) {
  const tone =
    kind === "ok"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
      : kind === "info"
        ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-100"
        : "border-red-500/30 bg-red-500/10 text-red-200";
  return (
    <div role={kind === "err" ? "alert" : "status"} className={`mb-4 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${tone}`}>
      <span className="min-w-0">{children}</span>
      <span className="flex shrink-0 items-center gap-2">
        {onRetry && (
          <button type="button" onClick={onRetry} className={`rounded px-1.5 text-xs underline opacity-90 hover:opacity-100 ${focusRing}`}>
            Try again
          </button>
        )}
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Dismiss" className={`rounded text-xs opacity-70 hover:opacity-100 ${focusRing}`}>
            ✕
          </button>
        )}
      </span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-white/10 px-4 py-8 text-center text-sm text-zinc-400">{children}</p>;
}

/** A small inline "nothing here" line for a list inside a panel. */
export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="py-2 text-sm text-zinc-400">{children}</p>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" aria-live="polite" className="px-1 py-6 text-sm text-zinc-400">
      {label}
    </p>
  );
}

/**
 * The three states every loaded view has, in one place, so a failed load
 * never leaves "Loading…" on screen and never shows "nothing here" beside
 * the error. `data` undefined/null = still loading (unless there's an error).
 */
export function LoadState<T>({
  data,
  error,
  onRetry,
  empty,
  isEmpty,
  children,
}: {
  data: T | null | undefined;
  error?: string | null;
  onRetry?: () => void;
  empty?: ReactNode;
  isEmpty?: (d: T) => boolean;
  children: (d: T) => ReactNode;
}) {
  if (error && (data == null || (isEmpty ? isEmpty(data) : false)))
    return (
      <Notice kind="err" onRetry={onRetry}>
        {error}
      </Notice>
    );
  if (data == null) return <Loading />;
  const none = isEmpty ? isEmpty(data) : Array.isArray(data) && data.length === 0;
  return (
    <>
      {error && (
        <Notice kind="err" onRetry={onRetry}>
          {error}
        </Notice>
      )}
      {none && empty !== undefined ? <Empty>{empty}</Empty> : children(data)}
    </>
  );
}

// ---------------------------------------------------------------- dialogs

const dialogStack: string[] = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The shell every admin dialog uses: a modal with its title wired up, focus
 * moved inside on open (the [autofocus] element, else the first control) and
 * kept there, Escape closing only the dialog on top, and focus returned to
 * whatever had it before.
 */
export function Dialog({
  title,
  onClose,
  children,
  wide,
  describedBy,
  z = 90,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  describedBy?: string;
  z?: number;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Read during the first render: by the time effects run, an autoFocus
  // field inside the dialog already has focus.
  const [before] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  useEffect(() => {
    dialogStack.push(id);
    const el = box.current;
    const first = (el?.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE) ?? el) as HTMLElement | null;
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dialogStack[dialogStack.length - 1] === id) {
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = dialogStack.lastIndexOf(id);
      if (i >= 0) dialogStack.splice(i, 1);
      if (before && document.contains(before)) before.focus();
    };
  }, [id, before]);
  const trap = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4" style={{ zIndex: z }}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={trap}
        className={`max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-white/10 bg-[#0B1220] p-5 shadow-2xl outline-none ${wide ? "max-w-2xl" : "max-w-md"}`}
      >
        <h2 id={`${id}-title`} className="text-base font-semibold text-white">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/**
 * A confirmation step for actions that are hard to undo. With `typeToConfirm`
 * the button stays disabled until that word is typed. If `onConfirm` returns
 * a promise and the dialog is still open, it shows that it is working.
 */
export function Confirm({
  title,
  body,
  confirmLabel,
  danger,
  typeToConfirm,
  withReason,
  reasonRequired,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
  withReason?: string;
  reasonRequired?: boolean;
  onConfirm: (reason: string) => void | Promise<unknown>;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const bodyId = useId();
  const ready = (!typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.trim().toLowerCase()) && (!reasonRequired || !!reason.trim());
  return (
    <Dialog title={title} onClose={() => !busy && onCancel()} describedBy={bodyId}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready || busy) return;
          const r = onConfirm(reason.trim());
          if (r && typeof (r as Promise<unknown>).then === "function") {
            setBusy(true);
            try {
              await r;
            } finally {
              if (live.current) setBusy(false);
            }
          }
        }}
      >
        <div id={bodyId} className="mt-1 text-sm text-zinc-400">
          {body}
        </div>
        {withReason && (
          <label className="mt-3 block text-sm text-zinc-300">
            {withReason}
            {reasonRequired && <span className="text-zinc-400"> (required)</span>}
            <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className={`${field} mt-1`} maxLength={300} required={reasonRequired} />
          </label>
        )}
        {typeToConfirm && (
          <label className="mt-3 block text-sm text-zinc-300">
            Type <b className="font-mono text-white">{typeToConfirm}</b> to confirm
            <input autoFocus={!withReason} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className={`${field} mt-1`} />
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className={btn.ghost}>
            Cancel
          </button>
          <button type="submit" disabled={!ready || busy} aria-busy={busy} className={danger ? btn.danger : btn.primary}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- figures

/**
 * One summary figure. With `href` or `onClick` it opens the list behind the
 * number; `active` marks the tile whose filter is applied.
 */
export function StatTile({
  label,
  value,
  hint,
  href,
  onClick,
  active,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
  onClick?: () => void;
  active?: boolean;
  tone?: "red" | "amber" | "green";
}) {
  const valueTone = tone === "red" ? "text-red-300" : tone === "amber" ? "text-amber-300" : tone === "green" ? "text-emerald-300" : "text-white";
  const inner = (
    <>
      <span className="block truncate text-xs text-zinc-400">{label}</span>
      <span className={`mt-0.5 block text-xl font-semibold tabular-nums ${valueTone}`}>{value}</span>
      {hint && <span className="mt-0.5 block truncate text-[11px] text-zinc-400">{hint}</span>}
    </>
  );
  const cls = `block min-w-0 rounded-xl border p-3 text-left transition ${
    active ? "border-cyan-400/60 bg-cyan-400/10" : "border-white/10 bg-white/[0.03]"
  } ${href || onClick ? `hover:border-cyan-400/40 hover:bg-white/[0.05] ${focusRing}` : ""}`;
  if (href)
    return (
      <Link href={href} className={cls} aria-current={active ? "true" : undefined}>
        {inner}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} aria-pressed={!!active} className={`${cls} w-full`}>
        {inner}
      </button>
    );
  return <div className={cls}>{inner}</div>;
}

// ---------------------------------------------------------------- tabs

/**
 * In-page tabs: arrow keys move between them, each tab names the panel it
 * controls. Render the selected panel with <TabPanel id={…}>.
 */
export function Tabs<K extends string>({
  label,
  tabs,
  value,
  onChange,
  idBase,
}: {
  label: string;
  tabs: readonly { id: K; label: ReactNode }[];
  value: K;
  onChange: (id: K) => void;
  idBase: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (i: number) => {
    const n = (i + tabs.length) % tabs.length;
    onChange(tabs[n].id);
    refs.current[n]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="mb-4 flex gap-1 overflow-x-auto border-b border-white/10 pb-px">
      {tabs.map((t, i) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.id}`}
            aria-selected={on}
            aria-controls={`${idBase}-panel`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") move(i + 1);
              else if (e.key === "ArrowLeft") move(i - 1);
              else if (e.key === "Home") move(0);
              else if (e.key === "End") move(tabs.length - 1);
              else return;
              e.preventDefault();
            }}
            className={`whitespace-nowrap rounded-t-lg px-3 py-2 text-sm ${on ? "border-b-2 border-cyan-400 text-cyan-100" : "text-zinc-400 hover:text-zinc-100"} ${focusRing}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idBase, value, children }: { idBase: string; value: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${value}`}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- tables

/** A table that scrolls sideways inside its panel on a narrow screen, never the page. */
export function TableWrap({ children, minWidth = 640, className = "" }: { children: ReactNode; minWidth?: number; className?: string }) {
  return (
    <div className={`relative overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] ${className}`}>
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export type SortDir = "asc" | "desc";

/** A column header that sorts the table; says which way it is sorted to screen readers. */
export function SortTh({
  label,
  k,
  sort,
  onSort,
  className = "",
}: {
  label: ReactNode;
  k: string;
  sort: { key: string; dir: SortDir };
  onSort: (key: string, dir: SortDir) => void;
  className?: string;
}) {
  const on = sort.key === k;
  return (
    <th aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={`px-3 py-2 font-medium ${className}`}>
      <button
        type="button"
        onClick={() => onSort(k, on && sort.dir === "desc" ? "asc" : "desc")}
        className={`inline-flex items-center gap-1 rounded hover:text-zinc-200 ${on ? "text-zinc-200" : ""} ${focusRing}`}
      >
        {label}
        <span aria-hidden className="text-[10px]">
          {on ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

/** Page x of y, page size, previous/next. Always shows the total so a one-page list still says how many. */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  sizes = [25, 50, 100],
  noun = "item",
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize?: (n: number) => void;
  sizes?: number[];
  noun?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pages" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-400">
      <span>
        {total === 0 ? `No ${noun}s` : `${from}–${to} of ${total} ${noun}${total === 1 ? "" : "s"}`}
        {pages > 1 && ` · page ${page} of ${pages}`}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {onPageSize && (
          <select aria-label="Rows per page" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} className={`${field} w-auto py-1.5`}>
            {sizes.map((n) => (
              <option key={n} value={n}>
                {n} a page
              </option>
            ))}
          </select>
        )}
        <button type="button" className={btn.ghost} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button type="button" className={btn.ghost} disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </span>
    </nav>
  );
}

/**
 * Sorting and paging for a list that is already all in memory. `get` maps a
 * row and a sort key to the value compared (numbers, strings or null).
 */
export function useClientTable<T>(
  rows: readonly T[] | null | undefined,
  get: (row: T, key: string) => string | number | null | undefined,
  initial: { key: string; dir: SortDir; pageSize?: number },
) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir }>({ key: initial.key, dir: initial.dir });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initial.pageSize ?? 25);
  const getRef = useRef(get);
  getRef.current = get;
  const sorted = useMemo(() => {
    if (!rows) return [];
    const out = [...rows];
    const g = getRef.current;
    out.sort((a, b) => {
      const x = g(a, sort.key);
      const y = g(b, sort.key);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
      return sort.dir === "asc" ? c : -c;
    });
    return out;
  }, [rows, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);
  return {
    sort,
    onSort: (key: string, dir: SortDir) => {
      setSort({ key, dir });
      setPage(1);
    },
    page: safePage,
    pageSize,
    total: sorted.length,
    visible,
    sorted,
    setPage,
    setPageSize: (n: number) => {
      setPageSize(n);
      setPage(1);
    },
  };
}

/** Row selection for bulk actions: a header checkbox for the visible rows and one per row. */
export function useSelection(ids: readonly string[]) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const key = ids.join("|");
  useEffect(() => {
    // Keep only what is still listed.
    setSel((s) => {
      const keep = new Set([...s].filter((id) => ids.includes(id)));
      return keep.size === s.size ? s : keep;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const all = ids.length > 0 && ids.every((id) => sel.has(id));
  return {
    selected: sel,
    count: sel.size,
    all,
    some: sel.size > 0 && !all,
    toggle: (id: string) =>
      setSel((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    toggleAll: () => setSel(all ? new Set() : new Set(ids)),
    clear: () => setSel(new Set()),
  };
}

export function SelectBox({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} aria-label={label} className="h-4 w-4 accent-cyan-400" />;
}

// ---------------------------------------------------------------- filters

/**
 * Filters kept in the address bar: read once from the URL with the
 * defaults filled in, and written back with router.replace so the view can
 * be bookmarked, shared and reloaded. Values equal to their default are left
 * out of the URL.
 */
export function useUrlFilters<F extends Record<string, string>>(defaults: F) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() || "";
  const defaultsKey = JSON.stringify(defaults);
  const value = useMemo(() => {
    const d = JSON.parse(defaultsKey) as F;
    const out = { ...d };
    for (const k of Object.keys(d) as (keyof F)[]) {
      const v = sp?.get(k as string);
      if (v != null) out[k] = v as F[keyof F];
    }
    return out;
  }, [sp, defaultsKey]);
  const set = useCallback(
    (patch: Partial<F>) => {
      const d = JSON.parse(defaultsKey) as F;
      const next = new URLSearchParams(sp?.toString() ?? "");
      for (const [k, v] of Object.entries({ ...value, ...patch })) {
        if (v == null || v === "" || v === d[k]) next.delete(k);
        else next.set(k, String(v));
      }
      const q = next.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [sp, router, pathname, value, defaultsKey],
  );
  const reset = useCallback(() => {
    const next = new URLSearchParams(sp?.toString() ?? "");
    for (const k of Object.keys(JSON.parse(defaultsKey))) next.delete(k);
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }, [sp, router, pathname, defaultsKey]);
  const active = Object.keys(value).some((k) => value[k] !== (JSON.parse(defaultsKey) as F)[k]);
  return { value, set, reset, active };
}

/** The row of filters above a list: wraps on a narrow screen, with a Clear button when any filter is set. */
export function FilterBar({ children, onClear, active }: { children: ReactNode; onClear?: () => void; active?: boolean }) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      {children}
      {active && onClear && (
        <button type="button" onClick={onClear} className={btn.ghost}>
          Clear filters
        </button>
      )}
    </div>
  );
}

/** A labelled control in a FilterBar or form: the label is visible and names the control. */
export function Labeled({ label, children, className = "" }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 text-xs text-zinc-400 ${className}`}>
      {label}
      {children}
    </label>
  );
}
