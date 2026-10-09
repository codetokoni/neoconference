"use client";

// src/app/admin/events/admin-events-client.tsx
// Every meeting on the platform: search, filters, sort and pages, all kept
// in the address bar so the Overview ("?state=live"), the admin search and
// user pages ("?q=") can link straight to a filtered list. Per-row actions
// live in EventActions.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, Radio, Ticket, Video, Link as LinkIcon } from "lucide-react";
import type { AdminEventView, EventState, EventVisibility } from "@/types/event";
import { Time, errorText, fmtNumber, useAdmin } from "../AdminApi";
import { FilterBar, Labeled, LoadState, Notice, PageHeader, Pager, SortTh, TableWrap, field, useUrlFilters, type SortDir } from "../ui";
import EventActions, { type ActionResult } from "./EventActions";

type DateRange = "today" | "week" | "month" | "all";
type SortKey = "createdAt" | "updatedAt" | "name" | "ownerEmail";

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

// "Today" is a UTC day on the server; week and month are the last 7 / 30 days.
const DATE_RANGE_OPTIONS: ReadonlyArray<{ value: DateRange; label: string }> = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today (UTC)" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "Last 30 days" },
];

const SORTS: ReadonlyArray<SortKey> = ["createdAt", "updatedAt", "name", "ownerEmail"];
const PAGE_SIZES = [25, 50, 100];

const STATE_BADGE: Record<EventState, string> = {
  scheduled: "bg-zinc-700/60 text-zinc-300 border-zinc-600/40",
  waiting: "bg-amber-500/15 text-amber-400 border-amber-400/30",
  live: "bg-red-500/15 text-red-400 border-red-400/40 motion-safe:animate-pulse",
  ended: "bg-zinc-700/40 text-zinc-400 border-zinc-600/30",
  replay: "bg-cyan-500/15 text-cyan-400 border-cyan-400/30",
  archived: "bg-zinc-800/60 text-zinc-400 border-zinc-700/40 italic",
};

const DEFAULTS = { q: "", state: "", visibility: "", dateRange: "all", sort: "updatedAt", order: "desc", page: "1", pageSize: "25" };

function oneOf<T extends string>(v: string, allowed: ReadonlyArray<T>, fallback: T): T {
  return (allowed as ReadonlyArray<string>).includes(v) ? (v as T) : fallback;
}

const values = <T extends string>(opts: ReadonlyArray<{ value: T }>) => opts.map((o) => o.value);

export default function AdminEventsClient() {
  const { adminFetch, can } = useAdmin();
  const f = useUrlFilters(DEFAULTS);
  // The URL is the source of truth; anything it carries that the server would ignore reads as the default.
  const state = oneOf<"" | EventState>(f.value.state, values(STATE_OPTIONS), "");
  const visibility = oneOf<"" | EventVisibility>(f.value.visibility, values(VISIBILITY_OPTIONS), "");
  const dateRange = oneOf<DateRange>(f.value.dateRange, values(DATE_RANGE_OPTIONS), "all");
  const sort = oneOf<SortKey>(f.value.sort, SORTS, "updatedAt");
  const order: SortDir = f.value.order === "asc" ? "asc" : "desc";
  const page = Math.max(1, parseInt(f.value.page, 10) || 1);
  const pageSize = PAGE_SIZES.includes(Number(f.value.pageSize)) ? Number(f.value.pageSize) : 25;
  const q = f.value.q.trim();

  // The search box types freely and writes to the URL after a pause; a new
  // ?q= arriving from elsewhere (the admin search) replaces what is typed.
  const [text, setText] = useState(f.value.q);
  const written = useRef(f.value.q);
  useEffect(() => {
    if (f.value.q !== written.current) {
      written.current = f.value.q;
      setText(f.value.q);
    }
  }, [f.value.q]);
  const { set } = f;
  useEffect(() => {
    if (text === written.current) return;
    const t = window.setTimeout(() => {
      written.current = text;
      set({ q: text, page: "1" });
    }, 250);
    return () => window.clearTimeout(t);
  }, [text, set]);

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const reqIdRef = useRef(0);

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (state) params.set("state", state);
  if (visibility) params.set("visibility", visibility);
  if (dateRange !== "all") params.set("dateRange", dateRange);
  params.set("sort", sort);
  params.set("order", order);
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  const apiQuery = params.toString();

  const fetchEvents = useCallback(async () => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    const r = await adminFetch<ApiResponse>(`/api/admin/events?${apiQuery}`);
    if (myReq !== reqIdRef.current) return; // a newer request has started
    setLoading(false);
    if (r.ok) setData(r.data);
    else setError(`Could not load the meetings: ${errorText(r)}`);
  }, [adminFetch, apiQuery]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const filtered = !!(q || state || visibility || dateRange !== "all");
  const canWrite = can("events:write");
  const canSeeUsers = can("users:read");

  return (
    <div className="text-zinc-200">
      <PageHeader
        title="Meetings"
        sub={
          <>
            Every meeting and event on the platform.
            {data && (
              <span className="text-zinc-400">
                {" "}
                {fmtNumber(data.total)} {filtered ? "match these filters" : "in total"}.
              </span>
            )}
          </>
        }
      />

      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}

      <FilterBar
        active={f.active}
        onClear={() => {
          written.current = "";
          setText("");
          f.reset();
        }}
      >
        <Labeled label="Search" className="min-w-[12rem] flex-1">
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, address, owner…" className={field} />
        </Labeled>
        <Labeled label="State">
          <FilterSelect value={state} onChange={(v) => f.set({ state: v, page: "1" })} options={STATE_OPTIONS} />
        </Labeled>
        <Labeled label="Visibility">
          <FilterSelect value={visibility} onChange={(v) => f.set({ visibility: v, page: "1" })} options={VISIBILITY_OPTIONS} />
        </Labeled>
        <Labeled label="Created">
          <FilterSelect value={dateRange} onChange={(v) => f.set({ dateRange: v, page: "1" })} options={DATE_RANGE_OPTIONS} />
        </Labeled>
      </FilterBar>

      <LoadState
        data={data}
        error={error}
        onRetry={fetchEvents}
        isEmpty={(d) => d.total === 0}
        empty={filtered ? "No meetings match these filters." : "No meetings yet."}
      >
        {(d) => (
          <>
            <p role="status" aria-live="polite" className="sr-only">
              {loading ? "Refreshing the list…" : ""}
            </p>
            {d.events.length === 0 && (
              <Notice kind="info">
                This page is past the end of the list.{" "}
                <button type="button" className="underline" onClick={() => f.set({ page: "1" })}>
                  Go to the first page
                </button>
              </Notice>
            )}
            <TableWrap minWidth={860} className={loading ? "opacity-70" : ""}>
              <thead className="border-b border-white/10 text-xs text-zinc-400">
                <tr>
                  <SortTh label="Name" k="name" sort={{ key: sort, dir: order }} onSort={onSort} />
                  <th className="px-3 py-2 font-medium">State</th>
                  <SortTh label="Owner" k="ownerEmail" sort={{ key: sort, dir: order }} onSort={onSort} />
                  <SortTh label="Created" k="createdAt" sort={{ key: sort, dir: order }} onSort={onSort} />
                  <SortTh label="Last updated" k="updatedAt" sort={{ key: sort, dir: order }} onSort={onSort} />
                  <th className="px-3 py-2 font-medium">Flags</th>
                  <th className="w-10 px-2 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.events.map((ev) => (
                  <EventRow
                    key={ev.id}
                    ev={ev}
                    canWrite={canWrite}
                    canSeeUsers={canSeeUsers}
                    onStart={() => setMsg(null)}
                    onDone={(r) => {
                      setMsg(r);
                      if (r.kind === "ok") fetchEvents();
                    }}
                  />
                ))}
              </tbody>
            </TableWrap>
            <Pager
              page={d.page}
              pageSize={d.pageSize}
              total={d.total}
              noun="meeting"
              onPage={(p) => f.set({ page: String(p) })}
              onPageSize={(n) => f.set({ pageSize: String(n), page: "1" })}
              sizes={PAGE_SIZES}
            />
          </>
        )}
      </LoadState>
    </div>
  );

  function onSort(k: string, dir: SortDir) {
    // A new text column starts A→Z; a new date column starts newest first.
    const first = k !== sort && (k === "name" || k === "ownerEmail") ? "asc" : dir;
    f.set({ sort: k, order: first, page: "1" });
  }
}

function FilterSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: ReadonlyArray<{ value: string; label: string }> }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${field} w-auto`}>
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-zinc-900 text-zinc-200">
          {o.label}
        </option>
      ))}
    </select>
  );
}

function EventRow({
  ev,
  canWrite,
  canSeeUsers,
  onStart,
  onDone,
}: {
  ev: AdminEventView;
  canWrite: boolean;
  canSeeUsers: boolean;
  onStart: () => void;
  onDone: (r: ActionResult) => void;
}) {
  const owner = ev.ownerEmail || ev.ownerName || ev.ownerUserId;
  return (
    <tr className="border-b border-white/[0.04] transition-colors last:border-b-0 hover:bg-white/[0.03]">
      <td className="px-3 py-3 align-top">
        <a href={`/e/${ev.slug}`} target="_blank" rel="noopener noreferrer" className="font-medium text-zinc-100 hover:text-cyan-300">
          {ev.name || ev.slug}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        <div className="mt-0.5 truncate font-mono text-xs text-zinc-400">{ev.slug}</div>
      </td>
      <td className="px-3 py-3 align-top">
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STATE_BADGE[ev.state]}`}>{ev.state}</span>
      </td>
      <td className="px-3 py-3 align-top text-xs text-zinc-300">
        {canSeeUsers && ev.ownerUserId ? (
          <Link href={`/admin/users/${encodeURIComponent(ev.ownerUserId)}`} className="block truncate hover:text-cyan-300 hover:underline">
            {owner}
          </Link>
        ) : (
          <div className="truncate">{owner}</div>
        )}
        {ev.ownerEmail && ev.ownerName && <div className="mt-0.5 truncate text-zinc-400">{ev.ownerName}</div>}
      </td>
      <td className="px-3 py-3 align-top text-xs text-zinc-400">
        <Time ts={ev.createdAt} mode="relative" />
      </td>
      <td className="px-3 py-3 align-top text-xs text-zinc-400">
        <Time ts={ev.updatedAt} mode="relative" />
      </td>
      <td className="px-3 py-3 align-top">
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
          {!ev.hasRecording && !ev.isStreaming && !ev.isPaid && !ev.hasShortlink && !ev.customDomain && (
            <span className="text-zinc-700" aria-hidden="true">
              —
            </span>
          )}
        </div>
      </td>
      <td className="px-2 py-3 text-right align-top">
        <EventActions ev={ev} canWrite={canWrite} onStart={onStart} onDone={onDone} />
      </td>
    </tr>
  );
}
