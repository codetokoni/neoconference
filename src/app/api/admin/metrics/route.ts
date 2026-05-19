// src/app/api/admin/metrics/route.ts
// Admin-only platform-wide metrics aggregation. Read-only. Computes
// totals, daily series, plan breakdown over the eventStore. In-memory
// aggregation; at our scale (~hundreds today) this is trivial. Past
// ~10K events, move to indexed Redis sets.
//
// GET /api/admin/metrics
//   ?range=today|week|month|quarter|year|all|custom   (default 'month')
//   ?from=<ISO>                                       (only when range=custom)
//   ?to=<ISO>                                         (only when range=custom)
//
// Plan detection (env-var only, no Clerk roundtrips):
//   - Event is "paid" if tickets[] non-empty OR owner email is in
//     BOOTSTRAP_BUSINESS_EMAIL or ADMIN_EMAILS.
//   - Owners with publicMetadata.plan = 'pro' set manually in Clerk
//     dashboard are NOT detected here — they'd show as 'free'. Acceptable
//     limitation for this PR; flagged in the PR body.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { eventStore } from "@/lib/eventStore";
import type { NeoEvent } from "@/types/event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Range = "today" | "week" | "month" | "quarter" | "year" | "all" | "custom";
const RANGES: ReadonlyArray<Range> = ["today", "week", "month", "quarter", "year", "all", "custom"];

interface RangeInfo {
  from: string;       // ISO
  to: string;         // ISO
  fromMs: number;
  toMs: number;
  label: string;
}

interface DayBucket {
  date: string;       // YYYY-MM-DD
  count: number;
}

interface PlanCounts {
  eventCount: number;
  ownerCount: number;
  recordingCount: number;
}

interface MetricsResponse {
  range: { from: string; to: string; label: string };
  totalEvents: number;
  uniqueOwners: number;
  streamingMinutes: number;
  activeEventsNow: number;
  eventsPerDay: DayBucket[];
  planBreakdown: { free: PlanCounts; paid: PlanCounts };
}

const MS_PER_DAY = 86_400_000;

function isRange(v: string | null): v is Range {
  return !!v && (RANGES as ReadonlyArray<string>).includes(v);
}

function startOfTodayUtcMs(): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function computeRange(range: Range, fromQ: string | null, toQ: string | null): RangeInfo {
  const now = Date.now();
  if (range === "custom") {
    const fromMs = fromQ ? Date.parse(fromQ) : NaN;
    const toMs = toQ ? Date.parse(toQ) : NaN;
    const safeFrom = Number.isFinite(fromMs) ? fromMs : 0;
    const safeTo = Number.isFinite(toMs) ? toMs : now;
    return {
      from: new Date(safeFrom).toISOString(),
      to: new Date(safeTo).toISOString(),
      fromMs: safeFrom,
      toMs: safeTo,
      label: "Custom range",
    };
  }
  if (range === "today") {
    const fromMs = startOfTodayUtcMs();
    return {
      from: new Date(fromMs).toISOString(),
      to: new Date(now).toISOString(),
      fromMs,
      toMs: now,
      label: "Today",
    };
  }
  if (range === "all") {
    return {
      from: new Date(0).toISOString(),
      to: new Date(now).toISOString(),
      fromMs: 0,
      toMs: now,
      label: "All time",
    };
  }
  const daysBack: Record<Exclude<Range, "today" | "custom" | "all">, number> = {
    week: 7,
    month: 30,
    quarter: 90,
    year: 365,
  };
  const labelMap: Record<Exclude<Range, "today" | "custom" | "all">, string> = {
    week: "Last 7 days",
    month: "Last 30 days",
    quarter: "Last 90 days",
    year: "Last 365 days",
  };
  const days = daysBack[range as Exclude<Range, "today" | "custom" | "all">];
  const fromMs = now - days * MS_PER_DAY;
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(now).toISOString(),
    fromMs,
    toMs: now,
    label: labelMap[range as Exclude<Range, "today" | "custom" | "all">],
  };
}

function getPaidEmails(): Set<string> {
  const set = new Set<string>();
  const bootstrap = (process.env.BOOTSTRAP_BUSINESS_EMAIL || "").trim().toLowerCase();
  if (bootstrap) set.add(bootstrap);
  for (const e of (process.env.ADMIN_EMAILS || "").split(",")) {
    const v = e.trim().toLowerCase();
    if (v) set.add(v);
  }
  return set;
}

function isEventPaid(ev: NeoEvent, paidEmails: Set<string>): boolean {
  if ((ev.tickets || []).length > 0) return true;
  const email = (ev.ownerEmail || "").toLowerCase();
  if (email && paidEmails.has(email)) return true;
  return false;
}

function bucketByDay(events: NeoEvent[], fromMs: number, toMs: number): DayBucket[] {
  // Initialize every UTC day between from and to with 0 so the chart line
  // doesn't have gaps where no events were created.
  const startDay = new Date(fromMs);
  startDay.setUTCHours(0, 0, 0, 0);
  const endDay = new Date(toMs);
  endDay.setUTCHours(0, 0, 0, 0);
  const buckets = new Map<string, number>();
  for (let t = startDay.getTime(); t <= endDay.getTime(); t += MS_PER_DAY) {
    const key = new Date(t).toISOString().slice(0, 10);
    buckets.set(key, 0);
  }
  for (const ev of events) {
    const key = (ev.createdAt || "").slice(0, 10);
    if (buckets.has(key)) {
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));
}

function streamingMinutesOf(events: NeoEvent[]): number {
  let totalMs = 0;
  for (const ev of events) {
    if (!ev.startedAt || !ev.endedAt) continue;
    const a = Date.parse(ev.startedAt);
    const b = Date.parse(ev.endedAt);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const d = b - a;
    if (d > 0) totalMs += d;
  }
  return Math.round(totalMs / 60_000);
}

function planBreakdownOf(
  events: NeoEvent[],
  paidEmails: Set<string>
): { free: PlanCounts; paid: PlanCounts } {
  let freeEvents = 0;
  let paidEvents = 0;
  let freeRecordings = 0;
  let paidRecordings = 0;
  // Owner bucketing: an owner is "paid" if ANY of their events is paid.
  const ownerKey = (ev: NeoEvent) =>
    (ev.ownerEmail || ev.ownerUserId || "").toLowerCase();
  const ownerHasPaid = new Map<string, boolean>();
  for (const ev of events) {
    const paid = isEventPaid(ev, paidEmails);
    if (paid) {
      paidEvents += 1;
      paidRecordings += (ev.recordings || []).length;
    } else {
      freeEvents += 1;
      freeRecordings += (ev.recordings || []).length;
    }
    const key = ownerKey(ev);
    if (!key) continue;
    ownerHasPaid.set(key, (ownerHasPaid.get(key) || false) || paid);
  }
  let paidOwners = 0;
  let freeOwners = 0;
  for (const hasPaid of ownerHasPaid.values()) {
    if (hasPaid) paidOwners += 1;
    else freeOwners += 1;
  }
  return {
    free: { eventCount: freeEvents, ownerCount: freeOwners, recordingCount: freeRecordings },
    paid: { eventCount: paidEvents, ownerCount: paidOwners, recordingCount: paidRecordings },
  };
}

export async function GET(req: Request) {
  const caller = await requireRole(["admin"]);
  if (!caller) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const rangeParam = url.searchParams.get("range");
  const range: Range = isRange(rangeParam) ? rangeParam : "month";
  const fromQ = url.searchParams.get("from");
  const toQ = url.searchParams.get("to");
  const info = computeRange(range, fromQ, toQ);

  const all = await eventStore.listAll();

  // Always-current: NOT range-filtered.
  const activeEventsNow = all.filter((e) => e.state === "live").length;

  // Range-filtered events: createdAt within [fromMs, toMs].
  const inRange = all.filter((ev) => {
    const t = Date.parse(ev.createdAt || "");
    if (!Number.isFinite(t)) return false;
    return t >= info.fromMs && t <= info.toMs;
  });

  const uniqueOwners = new Set(inRange.map((e) => e.ownerUserId || "")).size;
  const streamingMinutes = streamingMinutesOf(inRange);
  const eventsPerDay = bucketByDay(inRange, info.fromMs, info.toMs);
  const paidEmails = getPaidEmails();
  const planBreakdown = planBreakdownOf(inRange, paidEmails);

  const body: MetricsResponse = {
    range: { from: info.from, to: info.to, label: info.label },
    totalEvents: inRange.length,
    uniqueOwners,
    streamingMinutes,
    activeEventsNow,
    eventsPerDay,
    planBreakdown,
  };
  return NextResponse.json(body);
}
