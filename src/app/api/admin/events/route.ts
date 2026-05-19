// src/app/api/admin/events/route.ts
// Admin-only platform-wide event list with search, filter, sort, pagination.
// Read-only. Write/management actions live elsewhere (Tier 2, PR C).
//
// GET /api/admin/events
//   ?q=<search>                         — case-insensitive substring across
//                                          name, slug, ownerEmail, ownerName
//   ?state=scheduled|waiting|live|ended|replay|archived
//   ?visibility=public|unlisted|private
//   ?dateRange=today|week|month|all    (default 'all', filters createdAt)
//   ?sort=createdAt|updatedAt|name|ownerEmail   (default 'updatedAt')
//   ?order=asc|desc                    (default 'desc')
//   ?page=1                            (1-based, default 1)
//   ?pageSize=25                       (default 25, max 100)
// Response: { events: AdminEventView[]; total; page; pageSize; pageCount }

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { eventStore } from "@/lib/eventStore";
import {
  toAdminView,
  type AdminEventView,
  type EventState,
  type EventVisibility,
  type NeoEvent,
} from "@/types/event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATES: ReadonlyArray<EventState> = [
  "scheduled",
  "waiting",
  "live",
  "ended",
  "replay",
  "archived",
];
const VISIBILITIES: ReadonlyArray<EventVisibility> = ["public", "unlisted", "private"];
type DateRange = "today" | "week" | "month" | "all";
const DATE_RANGES: ReadonlyArray<DateRange> = ["today", "week", "month", "all"];
type SortKey = "createdAt" | "updatedAt" | "name" | "ownerEmail";
const SORTS: ReadonlyArray<SortKey> = ["createdAt", "updatedAt", "name", "ownerEmail"];
type SortOrder = "asc" | "desc";

function isOneOf<T extends string>(value: string | null, allowed: ReadonlyArray<T>): T | null {
  if (!value) return null;
  return (allowed as ReadonlyArray<string>).includes(value) ? (value as T) : null;
}

function dateRangeCutoff(range: DateRange): number | null {
  if (range === "all") return null;
  const now = Date.now();
  if (range === "today") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (range === "week") return now - 7 * 24 * 60 * 60 * 1000;
  if (range === "month") return now - 30 * 24 * 60 * 60 * 1000;
  return null;
}

function matchesSearch(ev: NeoEvent, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const haystacks = [ev.name, ev.slug, ev.ownerEmail, ev.ownerName];
  return haystacks.some((s) => (s || "").toLowerCase().includes(needle));
}

function sortValue(ev: NeoEvent, key: SortKey): string {
  switch (key) {
    case "name":
      return (ev.name || "").toLowerCase();
    case "ownerEmail":
      return (ev.ownerEmail || "").toLowerCase();
    case "createdAt":
      return ev.createdAt || "";
    case "updatedAt":
    default:
      return ev.updatedAt || "";
  }
}

export async function GET(req: Request) {
  const caller = await requireRole(["admin"]);
  if (!caller) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const state = isOneOf<EventState>(url.searchParams.get("state"), STATES);
  const visibility = isOneOf<EventVisibility>(url.searchParams.get("visibility"), VISIBILITIES);
  const dateRange = isOneOf<DateRange>(url.searchParams.get("dateRange"), DATE_RANGES) || "all";
  const sort = isOneOf<SortKey>(url.searchParams.get("sort"), SORTS) || "updatedAt";
  const order: SortOrder = url.searchParams.get("order") === "asc" ? "asc" : "desc";
  const page = Math.max(parseInt(url.searchParams.get("page") || "1", 10) || 1, 1);
  const pageSizeRaw = parseInt(url.searchParams.get("pageSize") || "25", 10) || 25;
  const pageSize = Math.min(Math.max(pageSizeRaw, 1), 100);

  const all = await eventStore.listAll();
  const cutoff = dateRangeCutoff(dateRange);

  const filtered = all.filter((ev) => {
    if (state && ev.state !== state) return false;
    if (visibility && ev.visibility !== visibility) return false;
    if (cutoff !== null) {
      const createdMs = Date.parse(ev.createdAt || "");
      if (!Number.isFinite(createdMs) || createdMs < cutoff) return false;
    }
    if (!matchesSearch(ev, q)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const av = sortValue(a, sort);
    const bv = sortValue(b, sort);
    const cmp = av.localeCompare(bv);
    return order === "asc" ? cmp : -cmp;
  });

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);
  const events: AdminEventView[] = slice.map(toAdminView);

  return NextResponse.json({ events, total, page, pageSize, pageCount });
}
