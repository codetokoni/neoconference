// src/lib/admin/overview/sources.ts
//
// What the Overview reads, one source per card. Every source reads a store
// another part of the admin already keeps — Clerk, LiveKit, the activity
// log (src/lib/activity.ts), subscription records (src/lib/billing), the
// payment ledger (src/lib/finance), the file index (src/lib/content) and the
// ops records (src/lib/ops). Nothing here keeps a count of its own.
//
// A source returns data that does not depend on who is asking; which sources
// (and which parts of one) an administrator sees is decided in ./aggregate.ts
// from their permissions.

import { clerkClient } from "@clerk/nextjs/server";
import type { AdminPermission } from "@/lib/admin/catalog";
import { addDays, activeUsers, daysFromTo, dayInZone, foldHourly, total, zonedDayStart, type Period } from "@/lib/activityReports";
import { ACTIVITY_TYPES, activitySince, readDau, readHourly, utcDaysBetween } from "@/lib/activity";
import { clerkSignUps } from "@/lib/admin/analytics";
import { searchLogs } from "@/lib/admin/logs";
import { DAY_MS, hasAccess } from "@/lib/billing/model";
import { listByPeriodEnd, listEnded, listSubscriptions } from "@/lib/billing/subscriptions";
import { entriesBetween } from "@/lib/finance/ledger";
import { listCheckouts } from "@/lib/finance/checkouts";
import { outstanding, periodFigures, series as revenueSeries, type Bucket } from "@/lib/finance/revenue";
import { allFiles } from "@/lib/content/files";
import { backfillState } from "@/lib/content/backfill";
import { usageTotals } from "@/lib/content/admin";
import { contentTypeLabel, type ContentType } from "@/lib/content/model";
import { latestResults, type ProbeStatus } from "@/lib/ops/probes";
import { listIncidents } from "@/lib/ops/incidents";
import { listAlerts } from "@/lib/ops/alerts";
import { consecutiveFailures, jobNames, listFailedRuns, listRuns } from "@/lib/ops/jobs";
import { livekitClient } from "@/lib/meetingSweep";
import { overviewLinks as L } from "@/lib/admin/overview/links";
import { delta, moneyDelta, round2, type Delta, type MoneyDelta, type Periods } from "@/lib/admin/overview/period";

export interface SourceEnv {
  periods: Periods;
  now: number;
}

export interface SourceDef<T> {
  id: string;
  label: string;
  /** Every one of these is needed to see the card at all. */
  permissions: AdminPermission[];
  /** False when the figures do not depend on the date filter (cached once for every period). */
  periodic: boolean;
  load: (env: SourceEnv) => Promise<T>;
}

const inP = (t: number | null | undefined, p: Period) => t != null && t >= p.startMs && t <= p.endMs;

/* ---------------------------------- users --------------------------------- */

export interface UsersData {
  total: number;
  newUsers: Delta;
  /** Sign-ups per calendar day of the current period, in its zone. */
  daily: number[];
  days: string[];
  links: { total: string; newUsers: string };
}

const users: SourceDef<UsersData> = {
  id: "users",
  label: "Users",
  permissions: ["users:read"],
  periodic: true,
  async load({ periods: { current: p, previous: pp } }) {
    const client = await clerkClient();
    const totalCount = await client.users.getCount();
    const signUps = await clerkSignUps(Math.min(p.startMs, pp.startMs), Math.max(p.endMs, pp.endMs));
    if (!signUps) throw new Error("Clerk did not answer the sign-up lookup.");
    const perDay: Record<string, number> = {};
    let cur = 0;
    let prev = 0;
    for (const u of signUps) {
      if (inP(u.createdAt, p)) {
        cur++;
        const d = dayInZone(u.createdAt, p.tz);
        perDay[d] = (perDay[d] ?? 0) + 1;
      }
      if (inP(u.createdAt, pp)) prev++;
    }
    return {
      total: totalCount,
      newUsers: delta(cur, prev),
      daily: p.days.map((d) => perDay[d] ?? 0),
      days: p.days,
      links: { total: L.users(), newUsers: L.newUsers(p) },
    };
  },
};

/* ---------------------------------- online -------------------------------- */

export interface OnlineData {
  configured: boolean;
  /** Participants LiveKit reports across every room right now (recording and caption agents included). */
  participants: number;
  rooms: number;
  links: { live: string };
}

const online: SourceDef<OnlineData> = {
  id: "online",
  label: "Online now",
  permissions: ["users:read"],
  periodic: false,
  async load() {
    const svc = livekitClient();
    if (!svc) return { configured: false, participants: 0, rooms: 0, links: { live: L.liveMeetings() } };
    const rooms = (await svc.listRooms()) ?? [];
    const withPeople = rooms.filter((r) => Number(r.numParticipants) > 0);
    return {
      configured: true,
      participants: withPeople.reduce((s, r) => s + Number(r.numParticipants), 0),
      rooms: withPeople.length,
      links: { live: L.liveMeetings() },
    };
  },
};

/* --------------------------------- activity ------------------------------- */

export interface ActivityData {
  /** When the activity log began; nothing before it was recorded. */
  since: number | null;
  /** False when the comparison period starts before the log did. */
  comparable: boolean;
  dailyAvg: Delta;
  wau: Delta;
  mau: Delta;
  daily: number[];
  days: string[];
  features: Array<{ type: string; label: string; count: Delta; href: string }>;
  links: { active: string };
}

const activity: SourceDef<ActivityData> = {
  id: "activity",
  label: "Active users and feature usage",
  permissions: ["analytics:read"],
  periodic: true,
  async load({ periods: { current: p, previous: pp } }) {
    const since = await activitySince();
    // Active-user sets are per UTC day; WAU and MAU need the 29 days before each period's end.
    const dauDays = new Set([...daysFromTo(addDays(p.from, -29), p.to), ...daysFromTo(addDays(pp.from, -29), pp.to)]);
    const dau = await readDau([...dauDays]);
    const au = activeUsers(dau, p.days);
    const auPrev = activeUsers(dau, pp.days);
    const hourly = await readHourly([...new Set([...utcDaysBetween(pp.startMs, pp.endMs), ...utcDaysBetween(p.startMs, p.endMs)])]);
    const cur = foldHourly(hourly, p);
    const prev = foldHourly(hourly, pp);
    const features = Object.entries(ACTIVITY_TYPES)
      .filter(([, d]) => d.feature)
      .map(([type, d]) => ({
        type,
        label: d.label,
        count: delta(total(cur.counts[type]), total(prev.counts[type])),
        href: L.feature(p, type),
      }))
      .sort((a, b) => b.count.value - a.count.value);
    return {
      since,
      comparable: since != null && since <= pp.startMs,
      dailyAvg: delta(au.avgDaily, auPrev.avgDaily),
      wau: delta(au.wau, auPrev.wau),
      mau: delta(au.mau, auPrev.mau),
      daily: au.daily,
      days: p.days,
      features,
      links: { active: L.activeUsers(p) },
    };
  },
};

/* ------------------------------- subscriptions ---------------------------- */

export const RENEWAL_WINDOW_DAYS = 30;

export interface SubscriptionsData {
  total: number;
  /** Records that give their plan now. */
  live: number;
  byPlan: Array<{ planId: string; name: string; total: number; live: number; href: string }>;
  byStatus: Array<{ status: string; count: number; href: string }>;
  started: Delta;
  ended: Delta;
  /** Periods and trials ending in the next RENEWAL_WINDOW_DAYS days. */
  renewalsDue: number;
  /** Records that had started and not ended at the end of each day (reconstructed from their dates). */
  daily: number[];
  days: string[];
  links: { renewalsDue: string; all: string };
}

const subscriptions: SourceDef<SubscriptionsData> = {
  id: "subscriptions",
  label: "Subscriptions",
  permissions: ["plans:read"],
  periodic: true,
  async load({ periods: { current: p, previous: pp }, now }) {
    const all = await listSubscriptions();
    const plans = new Map<string, { name: string; total: number; live: number }>();
    const statuses = new Map<string, number>();
    let live = 0;
    for (const s of all) {
      const has = hasAccess(s, now);
      if (has) live++;
      const row = plans.get(s.planId) ?? { name: s.snapshot?.name || s.planId, total: 0, live: 0 };
      row.total++;
      if (has) row.live++;
      plans.set(s.planId, row);
      statuses.set(s.status, (statuses.get(s.status) ?? 0) + 1);
    }
    const ended = await listEnded(Math.min(p.startMs, pp.startMs), Math.max(p.endMs, pp.endMs), 5000);
    const due = await listByPeriodEnd(now, now + RENEWAL_WINDOW_DAYS * DAY_MS, 5000);
    const existed = (t: number) => all.filter((s) => s.createdAt <= t && (s.endedAt == null || s.endedAt > t)).length;
    return {
      total: all.length,
      live,
      byPlan: [...plans.entries()]
        .map(([planId, r]) => ({ planId, ...r, href: L.subscriptionsByPlan(planId) }))
        .sort((a, b) => b.total - a.total),
      byStatus: [...statuses.entries()].map(([status, count]) => ({ status, count, href: L.subscriptionsByStatus(status) })).sort((a, b) => b.count - a.count),
      started: delta(all.filter((s) => inP(s.createdAt, p)).length, all.filter((s) => inP(s.createdAt, pp)).length),
      ended: delta(ended.filter((s) => inP(s.endedAt, p)).length, ended.filter((s) => inP(s.endedAt, pp)).length),
      renewalsDue: due.length,
      daily: p.days.map((d) => existed(Math.min(zonedDayStart(addDays(d, 1), p.tz) - 1, now))),
      days: p.days,
      links: { renewalsDue: L.renewalsDue(RENEWAL_WINDOW_DAYS), all: L.subscriptionsByStatus("") },
    };
  },
};

/* --------------------------------- revenue -------------------------------- */

export interface RevenueData {
  gross: MoneyDelta;
  net: MoneyDelta;
  refunds: MoneyDelta;
  failed: { count: Delta; amount: Record<string, number> };
  outstanding: { inProgress: { count: number; amount: Record<string, number> }; abandoned: { count: number; amount: Record<string, number> } };
  payments: Delta;
  renewals: Delta;
  newCustomers: Delta;
  series: { bucket: Bucket; starts: string[]; byCurrency: Record<string, number[]> };
  links: { revenue: string; payments: string; failed: string; refunds: string };
}

const revenue: SourceDef<RevenueData> = {
  id: "revenue",
  label: "Revenue",
  permissions: ["billing:read"],
  periodic: true,
  async load({ periods: { current: p, previous: pp }, now }) {
    // Every payment up to the period's end: renewals are told from first
    // purchases by each account's earlier payments.
    const entries = await entriesBetween(0, Math.max(p.endMs, pp.endMs));
    const f = periodFigures(entries, p.startMs, p.endMs, now);
    const fp = periodFigures(entries, pp.startMs, pp.endMs, now);
    const out = outstanding(await listCheckouts(p.startMs, p.endMs), entries, p.startMs, p.endMs, now);
    const bucket: Bucket = p.days.length <= 92 ? "day" : "week";
    const points = revenueSeries(entries, p.startMs, p.endMs, bucket);
    const currencies = [...new Set(points.flatMap((x) => Object.keys(x.gross)))].sort();
    const byCurrency: Record<string, number[]> = {};
    for (const c of currencies) byCurrency[c] = points.map((x) => round2(x.gross[c] ?? 0));
    return {
      gross: moneyDelta(f.gross, fp.gross),
      net: moneyDelta(f.net, fp.net),
      refunds: moneyDelta(f.refunds, fp.refunds),
      failed: { count: delta(f.failed.count, fp.failed.count), amount: roundAll(f.failed.amount) },
      outstanding: {
        inProgress: { count: out.inProgress.count, amount: roundAll(out.inProgress.amount) },
        abandoned: { count: out.abandoned.count, amount: roundAll(out.abandoned.amount) },
      },
      payments: delta(f.payments, fp.payments),
      renewals: delta(f.renewals, fp.renewals),
      newCustomers: delta(f.newCustomers, fp.newCustomers),
      series: { bucket, starts: points.map((x) => new Date(x.start).toISOString().slice(0, 10)), byCurrency },
      links: { revenue: L.revenue(p), payments: L.payments(p), failed: L.failedPayments(p), refunds: L.refunds(p) },
    };
  },
};

function roundAll(m: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(m).map(([c, v]) => [c, round2(v)]));
}

/* --------------------------------- storage -------------------------------- */

export interface StorageData {
  files: number;
  bytes: number;
  byType: Array<{ type: ContentType; label: string; files: number; bytes: number; href: string }>;
  /** Of the above, in the bin (still stored until purged). */
  trashed: { files: number; bytes: number };
  /** Whether a full listing of R2 has been folded into the index; false = the totals are a floor. */
  complete: boolean;
  lastCompletePassAt: number | null;
  bandwidth: { available: false; reason: string };
  links: { storage: string };
}

export const BANDWIDTH_UNAVAILABLE =
  "R2 does not report egress to the app. Cloudflare's analytics API would, with an API token this deployment does not have.";

const storage: SourceDef<StorageData> = {
  id: "storage",
  label: "Storage",
  permissions: ["content:read"],
  periodic: false,
  async load() {
    const [files, state] = await Promise.all([allFiles(), backfillState()]);
    // The Content section's own totals: files in the bin still take space until purged, so they count.
    const usage = usageTotals(files);
    const bin = files.filter((f) => f.state === "trashed");
    return {
      files: usage.total.files,
      bytes: usage.total.bytes,
      byType: usage.byType.map((t) => ({ ...t, label: contentTypeLabel(t.type), href: L.storageByType(t.type) })),
      trashed: { files: bin.length, bytes: bin.reduce((s, f) => s + f.size, 0) },
      // Partial until one full listing has finished, and again while a new one is part-way through.
      complete: !!state.lastCompletePass && !state.token,
      lastCompletePassAt: state.lastCompletePass?.finishedAt ?? null,
      bandwidth: { available: false, reason: BANDWIDTH_UNAVAILABLE },
      links: { storage: L.storage() },
    };
  },
};

/* ---------------------------------- health -------------------------------- */

export interface HealthData {
  counts: Record<ProbeStatus, number>;
  services: Array<{ id: string; label: string; status: ProbeStatus; checkedAt: number; detail: string }>;
  /** When the newest check ran; null = never. */
  checkedAt: number | null;
  links: { health: string };
}

const health: SourceDef<HealthData> = {
  id: "health",
  label: "Service health",
  permissions: ["ops:read"],
  periodic: false,
  async load() {
    const latest = Object.values(await latestResults());
    const counts: Record<ProbeStatus, number> = { up: 0, degraded: 0, down: 0, not_configured: 0 };
    for (const r of latest) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const order: Record<ProbeStatus, number> = { down: 0, degraded: 1, not_configured: 2, up: 3 };
    return {
      counts,
      services: latest
        .map((r) => ({ id: r.id, label: r.label, status: r.status, checkedAt: r.checkedAt, detail: r.detail }))
        .sort((a, b) => order[a.status] - order[b.status] || a.label.localeCompare(b.label)),
      checkedAt: latest.length ? Math.max(...latest.map((r) => r.checkedAt)) : null,
      links: { health: L.health() },
    };
  },
};

export interface IncidentsData {
  open: Array<{ id: string; title: string; impact: string; status: string; createdAt: number }>;
  alerts: { active: number; open: number; acknowledged: number };
  links: { incidents: string; alerts: string };
}

const incidents: SourceDef<IncidentsData> = {
  id: "incidents",
  label: "Incidents and alerts",
  permissions: ["ops:read"],
  periodic: false,
  async load() {
    const [all, active] = await Promise.all([listIncidents(), listAlerts({ status: "active", limit: 500 })]);
    return {
      open: all
        .filter((i) => i.status !== "resolved")
        .map((i) => ({ id: i.id, title: i.title, impact: i.impact, status: i.status, createdAt: i.createdAt })),
      alerts: {
        active: active.length,
        open: active.filter((a) => a.status === "open").length,
        acknowledged: active.filter((a) => a.status === "acknowledged").length,
      },
      links: { incidents: L.incidents(), alerts: L.alerts() },
    };
  },
};

export interface JobsData {
  jobs: Array<{ name: string; outcome: string | null; at: number | null; failingRuns: number; href: string }>;
  failing: number;
  running: number;
  failedRuns: Delta;
  links: { jobs: string; failed: string };
}

const jobs: SourceDef<JobsData> = {
  id: "jobs",
  label: "Background jobs",
  permissions: ["ops:read"],
  periodic: true,
  async load({ periods: { current: p, previous: pp } }) {
    const names = await jobNames();
    const rows = await Promise.all(
      names.map(async (name) => {
        const runs = await listRuns(name, 10);
        const last = runs[0] ?? null;
        return { name, outcome: last?.outcome ?? null, at: last ? (last.endedAt ?? last.startedAt) : null, failingRuns: consecutiveFailures(runs), href: L.job(name) };
      }),
    );
    const failed = await listFailedRuns(500);
    return {
      jobs: rows.sort((a, b) => b.failingRuns - a.failingRuns || a.name.localeCompare(b.name)),
      failing: rows.filter((r) => r.failingRuns > 0).length,
      running: rows.filter((r) => r.outcome === "running").length,
      failedRuns: delta(failed.filter((r) => inP(r.startedAt, p)).length, failed.filter((r) => inP(r.startedAt, pp)).length),
      links: { jobs: L.jobs(), failed: L.failedJobs() },
    };
  },
};

/* ---------------------------------- errors -------------------------------- */

export interface ErrorsData {
  /** Error-severity events in the activity log (what people and the app did). */
  activity: Delta & { truncated: boolean };
  /** Administrator actions that failed (the admin audit). Shown only with audit:read. */
  admin: Delta & { truncated: boolean };
  links: { errors: string };
}

const errors: SourceDef<ErrorsData> = {
  id: "errors",
  label: "Errors",
  permissions: ["analytics:read"],
  periodic: true,
  async load({ periods: { current: p, previous: pp } }) {
    const count = async (source: "activity" | "admin", x: Period) => {
      const r = await searchLogs({ sources: [source], severity: "error", from: x.startMs, to: x.endMs, limit: 1, offset: 0 });
      return { n: r.total, truncated: r.truncated };
    };
    const [a, ap, m, mp] = await Promise.all([count("activity", p), count("activity", pp), count("admin", p), count("admin", pp)]);
    return {
      activity: { ...delta(a.n, ap.n), truncated: a.truncated || ap.truncated },
      admin: { ...delta(m.n, mp.n), truncated: m.truncated || mp.truncated },
      links: { errors: L.errors(p) },
    };
  },
};

/* --------------------------------------------------------------------------- */

export const SOURCES = [users, online, activity, subscriptions, revenue, storage, health, incidents, jobs, errors] as const;
export type SourceId = keyof SourceData;

export interface SourceData {
  users: UsersData;
  online: OnlineData;
  activity: ActivityData;
  subscriptions: SubscriptionsData;
  revenue: RevenueData;
  storage: StorageData;
  health: HealthData;
  incidents: IncidentsData;
  jobs: JobsData;
  errors: ErrorsData;
}
