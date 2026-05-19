"use client";

// src/app/admin/events/admin-events-client.tsx
// Read-only platform-wide events table. Filters, sorts, paginates. No
// write actions in this PR (Tier 1). Admin actions land in PR C.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Globe,
  Loader2,
  Radio,
  Search,
  Ticket,
  Video,
  Link as LinkIcon,
} from "lucide-react";
import type { AdminEventView, EventState, EventVisibility } from "@/types/event";

type DateRange = "today" | "week" | "month" | "all";
type SortKey = "createdAt" | "updatedAt" | "name" | "ownerEmail";
type SortOrder = "asc" | "desc";

interface ApiResponse {
  events: AdminEventView[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const STATE_OPTIONS: ReadonlyArray<{ value: "" | EventState; label: string }> = [
  { value: "", label: "All states" },
  { value: "scheduled", label: "Scheduled" },
  { value: "waiting", label: "Waiting" },
  { value: "live", label: "Live" },
  { value: "ended", label: "Ended" },
  { value: "replay", label: "Replay" },
  { value: "archived", label: "Archived" },
];

const VISIBILITY_OPTIONS: ReadonlyArray<{ value: "" | EventVisibility; label: string }> = [
  { value: "", label: "All visibility" },
  { value: "public", label: "Public" },
  { value: "unlisted", label: "Unlisted" },
  { value: "private", label: "Private" },
];

const DATE_RANGE_OPTIONS: ReadonlyArray<{ value: DateRange; label: string }> = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];

const PAGE_SIZE_OPTIONS: ReadonlyArray<number> = [25, 50, 100];

const STATE_BADGE: Record<EventState, string> = {
  scheduled: "bg-zinc-700/60 text-zinc-300 border-zinc-600/40",
  waiting: "bg-amber-500/15 text-amber-400 border-amber-400/30",
  live: "bg-red-500/15 text-red-400 border-red-400/40 animate-pulse",
  ended: "bg-zinc-700/40 text-zinc-400 border-zinc-600/30",
  replay: "bg-cyan-500/15 text-cyan-400 border-cyan-400/30",
  archived: "bg-zinc-800/60 text-zinc-500 border-zinc-700/40 italic",
};

function formatRelative(iso: string | undefined): { label: string; full: string } {
  if (!iso) return { label: "—", full: "" };
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { label: "—", full: iso };
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return { label: "just now", full: iso };
  const min = Math.floor(sec / 60);
  if (min < 60) return { label: `${min}m ago`, full: iso };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { label: `${hr}h ago`, full: iso };
  const day = Math.floor(hr / 24);
  if (day < 30) return { label: `${day}d ago`, full: iso };
  const mo = Math.floor(day / 30);
  if (mo < 12) return { label: `${mo}mo ago`, full: iso };
  const yr = Math.floor(day / 365);
  return { label: `${yr}y ago`, full: iso };
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [v, setV] = useState<T>(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return v;
}

export default function AdminEventsClient() {
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 250);
  const [state, setState] = useState<"" | EventState>("");
  const [visibility, setVisibility] = useState<"" | EventVisibility>("");
  const [dateRange, setDateRange] = useState<DateRange>("all");
  const [sort, setSort] = useState<SortKey>("updatedAt");
  const [order, setOrder] = useState<SortOrder>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  // Reset to page 1 whenever a filter/sort/pageSize change would shift results.
  useEffect(() => {
    setPage(1);
  }, [debouncedQ, state, visibility, dateRange, sort, order, pageSize]);

  const fetchEvents = useCallback(async () => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/admin/events", window.location.origin);
      if (debouncedQ) url.searchParams.set("q", debouncedQ);
      if (state) url.searchParams.set("state", state);
      if (visibility) url.searchParams.set("visibility", visibility);
      if (dateRange !== "all") url.searchParams.set("dateRange", dateRange);
      url.searchParams.set("sort", sort);
      url.searchParams.set("order", order);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(pageSize));
      const res = await fetch(url, { cache: "no-store" });
      const json = (await res.json()) as ApiResponse | { error?: string };
      if (!res.ok) {
        const msg = (json as { error?: string }).error || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      if (myReq === reqIdRef.current) {
        setData(json as ApiResponse);
      }
    } catch (e) {
      if (myReq === reqIdRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  }, [debouncedQ, state, visibility, dateRange, sort, order, page, pageSize]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const showingFrom = useMemo(
    () => (data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0),
    [data]
  );
  const showingTo = useMemo(
    () => (data ? Math.min(data.page * data.pageSize, data.total) : 0),
    [data]
  );

  const toggleSort = (key: SortKey) => {
    if (sort === key) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSort(key);
      setOrder(key === "name" || key === "ownerEmail" ? "asc" : "desc");
    }
  };

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 text-zinc-200">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold text-cyan-100">Admin · Events</h1>
        <p className="mt-1 text-sm text-zinc-400">
          All events across the platform.{" "}
          {data ? (
            <span className="text-zinc-500">
              Showing {data.total === 0 ? 0 : `${showingFrom}–${showingTo}`} of {data.total}{" "}
              {data.total === 1 ? "event" : "events"}
            </span>
          ) : null}
        </p>
      </header>

      <div
        className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border p-3 sm:p-4 backdrop-blur-xl"
        style={{
          background: "rgba(0,0,0,0.4)",
          borderColor: "rgba(255,255,255,0.08)",
          borderWidth: "0.5px",
        }}
      >
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, slug, owner..."
            className="w-full rounded-lg border border-white/10 bg-black/40 py-2 pl-9 pr-3 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition focus:border-cyan-400/60 focus:ring-1 focus:ring-cyan-400/40"
          />
        </div>
        <FilterSelect
          value={state}
          onChange={(v) => setState(v as "" | EventState)}
          options={STATE_OPTIONS}
        />
        <FilterSelect
          value={visibility}
          onChange={(v) => setVisibility(v as "" | EventVisibility)}
          options={VISIBILITY_OPTIONS}
        />
        <FilterSelect
          value={dateRange}
          onChange={(v) => setDateRange(v as DateRange)}
          options={DATE_RANGE_OPTIONS}
        />
      </div>

      <div
        className="overflow-hidden rounded-2xl border backdrop-blur-xl"
        style={{
          background: "rgba(0,0,0,0.4)",
          borderColor: "rgba(255,255,255,0.08)",
          borderWidth: "0.5px",
        }}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-white/[0.08] text-[10px] font-medium uppercase tracking-widest text-zinc-500">
              <tr>
                <SortableTh label="Name" col="name" sort={sort} order={order} onClick={toggleSort} />
                <th className="px-4 py-3">State</th>
                <SortableTh label="Owner" col="ownerEmail" sort={sort} order={order} onClick={toggleSort} />
                <SortableTh label="Created" col="createdAt" sort={sort} order={order} onClick={toggleSort} />
                <SortableTh label="Last updated" col="updatedAt" sort={sort} order={order} onClick={toggleSort} />
                <th className="px-4 py-3">Flags</th>
              </tr>
            </thead>
            <tbody>
              {error && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-red-400">
                    Failed to load events: {error}
                  </td>
                </tr>
              )}
              {!error && data && data.events.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-zinc-500">
                    {debouncedQ || state || visibility || dateRange !== "all"
                      ? "No events match these filters."
                      : "No events yet."}
                  </td>
                </tr>
              )}
              {!error &&
                data &&
                data.events.map((ev) => <EventRow key={ev.id} ev={ev} />)}
              {!error && !data && loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-zinc-500">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-cyan-300" aria-hidden="true" />
                    <div className="mt-2">Loading events...</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-zinc-500">
          {data && (
            <>
              Page {data.page} of {data.pageCount} · {data.total} total{" "}
              {data.total === 1 ? "event" : "events"}
              {loading && <span className="ml-2 text-cyan-400/60">refreshing...</span>}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-500" htmlFor="page-size">
            Per page
          </label>
          <select
            id="page-size"
            value={pageSize}
            onChange={(e) => setPageSize(parseInt(e.target.value, 10) || 25)}
            className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-cyan-400/60"
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n} className="bg-zinc-900 text-zinc-200">
                {n}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={!data || data.page <= 1}
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-1 text-xs text-zinc-200 transition hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-30"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => (data ? Math.min(data.pageCount, p + 1) : p))}
            disabled={!data || data.page >= data.pageCount}
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-1 text-xs text-zinc-200 transition hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-30"
          >
            Next
          </button>
        </div>
      </div>
    </main>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-zinc-200 outline-none transition focus:border-cyan-400/60 focus:ring-1 focus:ring-cyan-400/40"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-zinc-900 text-zinc-200">
          {o.label}
        </option>
      ))}
    </select>
  );
}

function SortableTh({
  label,
  col,
  sort,
  order,
  onClick,
}: {
  label: string;
  col: SortKey;
  sort: SortKey;
  order: SortOrder;
  onClick: (col: SortKey) => void;
}) {
  const active = sort === col;
  const Icon = !active ? ArrowUpDown : order === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className="px-4 py-3">
      <button
        type="button"
        onClick={() => onClick(col)}
        className={[
          "inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-widest transition-colors",
          active ? "text-cyan-300" : "text-zinc-500 hover:text-zinc-300",
        ].join(" ")}
      >
        {label}
        <Icon className="h-3 w-3" aria-hidden="true" />
      </button>
    </th>
  );
}

function EventRow({ ev }: { ev: AdminEventView }) {
  const created = formatRelative(ev.createdAt);
  const updated = formatRelative(ev.updatedAt);
  const owner = ev.ownerEmail || ev.ownerName || ev.ownerUserId;
  return (
    <tr className="border-b border-white/[0.04] last:border-b-0 transition-colors hover:bg-white/[0.03]">
      <td className="px-4 py-3 align-top">
        <a
          href={`/e/${ev.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-zinc-100 hover:text-cyan-300"
        >
          {ev.name || ev.slug}
        </a>
        <div className="mt-0.5 truncate text-xs text-zinc-500">{ev.slug}</div>
      </td>
      <td className="px-4 py-3 align-top">
        <span
          className={[
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
            STATE_BADGE[ev.state],
          ].join(" ")}
        >
          {ev.state}
        </span>
      </td>
      <td className="px-4 py-3 align-top text-xs text-zinc-300">
        <div className="truncate">{owner}</div>
        {ev.ownerEmail && ev.ownerName && (
          <div className="mt-0.5 truncate text-zinc-500">{ev.ownerName}</div>
        )}
      </td>
      <td className="px-4 py-3 align-top text-xs text-zinc-400" title={created.full}>
        {created.label}
      </td>
      <td className="px-4 py-3 align-top text-xs text-zinc-400" title={updated.full}>
        {updated.label}
      </td>
      <td className="px-4 py-3 align-top">
        <div className="flex items-center gap-2 text-zinc-400">
          {ev.hasRecording && (
            <span title={`Recording (${ev.recordingCount})`}>
              <Video className="h-4 w-4 text-cyan-400/80" aria-hidden="true" />
              <span className="sr-only">Has {ev.recordingCount} recordings</span>
            </span>
          )}
          {ev.isStreaming && (
            <span title="Streaming binding">
              <Radio className="h-4 w-4 text-red-400/80" aria-hidden="true" />
              <span className="sr-only">Streaming</span>
            </span>
          )}
          {ev.isPaid && (
            <span title="Has paid tickets">
              <Ticket className="h-4 w-4 text-amber-400/80" aria-hidden="true" />
              <span className="sr-only">Paid tickets</span>
            </span>
          )}
          {ev.hasShortlink && (
            <span title="Real shortlink (non-fallback)">
              <LinkIcon className="h-4 w-4 text-zinc-300" aria-hidden="true" />
              <span className="sr-only">Has shortlink</span>
            </span>
          )}
          {ev.customDomain && (
            <span title={`Custom domain: ${ev.customDomain}`}>
              <Globe className="h-4 w-4 text-indigo-400/80" aria-hidden="true" />
              <span className="sr-only">Custom domain {ev.customDomain}</span>
            </span>
          )}
          {!ev.hasRecording &&
            !ev.isStreaming &&
            !ev.isPaid &&
            !ev.hasShortlink &&
            !ev.customDomain && (
              <span className="text-zinc-700" aria-hidden="true">
                —
              </span>
            )}
        </div>
      </td>
    </tr>
  );
}
