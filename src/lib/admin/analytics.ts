// src/lib/admin/analytics.ts
//
// Everything /admin/analytics shows, for one period and the period before it.
// Two kinds of source, and the page labels which is which:
//
//   - the activity log (src/lib/activity.ts): sign-ups, sign-ins, active
//     users, joins, recordings, features, API calls, purchases, cancellations,
//     plans ending (from the subscription records' changes).
//     Exists from the deploy that added it; nothing earlier.
//   - stores that kept their own history: meetings and their minutes
//     (eventStore), real plans (Clerk publicMetadata.plan).
//
// Titles and names of meetings appear only for administrators who also hold
// events:read; nothing here reads a meeting's content (chat, transcripts,
// recordings).

import { clerkClient } from "@clerk/nextjs/server";
import {
  ACTIVITY_TYPES,
  activitySince,
  readAccounts,
  readDau,
  readHourly,
  readNewUsers,
  utcDay,
  utcDaysBetween,
} from "@/lib/activity";
import {
  activeUsers,
  addDays,
  change,
  dayInZone,
  daysFromTo,
  foldHourly,
  mondayOf,
  previousPeriod,
  series,
  splitTotals,
  total,
  weeklyCohorts,
  type Cohort,
  type Folded,
  type Period,
} from "@/lib/activityReports";
import { eventStore } from "@/lib/eventStore";
import type { Table } from "@/lib/admin/exportReport";
import { readPlanFromMetadata } from "@/lib/planLimits";
import { isOwnerEmailList, type ClerkEmailish } from "@/lib/admin/owner";
import { isAdmin as isEnvAdmin } from "@/lib/roles";
import type { NeoEvent } from "@/types/event";

/** Where an account's row links: its page in the admin (/admin/users/[id]). */
export const accountHref = (id: string) => `/admin/users/${encodeURIComponent(id)}`;

export type FigureKey =
  | "signUps"
  | "signIns"
  | "activeDaily"
  | "wau"
  | "mau"
  | "meetings"
  | "meetingMinutes"
  | "joins"
  | "recordingHours"
  | "apiCalls"
  | "purchases"
  | "conversions"
  | "cancellations"
  | "downgrades"
  | "failedAdminSignIns";

export interface Figure {
  key: FigureKey;
  label: string;
  value: number;
  previous: number;
  change: number | null;
  source: "log" | "store";
  /** Where the underlying records are: a logs search, or this page's records list. */
  drill:
    | { kind: "logs"; type: string }
    | { kind: "records"; metric: "meetings" | "meetingMinutes" | "signUps" }
    | { kind: "accounts"; sort: keyof AccountRow };
}

export interface AccountRow {
  id: string;
  label: string;
  email: string;
  plan: string;
  meetings: number;
  meetingMinutes: number;
  participants: number;
  recordingHours: number;
  apiCalls: number;
  uploadMB: number;
  href: string;
}

export interface AnalyticsReport {
  period: Pick<Period, "from" | "to" | "tz" | "startMs" | "endMs">;
  previous: Pick<Period, "from" | "to" | "tz" | "startMs" | "endMs">;
  logSince: number | null;
  /** First UTC week the log saw whole; cohorts start there. */
  cohortsFrom: string | null;
  days: string[];
  figures: Figure[];
  daily: Record<string, number[]>;
  retention: Cohort[];
  conversion: { conversions: number; purchases: number; revenueEsp: number; perSignUp: number | null; byFromPlan: Record<string, number> };
  /** Cancellations requested, and plans that ended (back to Free), with the plan they left. */
  cancellations: { cancelled: number; previousCancelled: number; ended: number; previousEnded: number; endedByPlan: Record<string, number> };
  features: Array<{ type: string; label: string; count: number; previous: number; change: number | null }>;
  accounts: AccountRow[];
  plans: Array<{ plan: string; owners: number; meetings: number }>;
  liveNow: number;
}

const ms = (iso: string | undefined) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : NaN;
};

function minutesOf(ev: NeoEvent): number {
  const a = ms(ev.startedAt);
  const b = ms(ev.endedAt);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? (b - a) / 60_000 : 0;
}

/** Meetings created in the period, and minutes of meetings that ended in it. */
export function meetingFigures(events: NeoEvent[], p: Period) {
  const created = events.filter((e) => {
    const t = ms(e.createdAt);
    return t >= p.startMs && t <= p.endMs;
  });
  const ended = events.filter((e) => {
    const t = ms(e.endedAt);
    return t >= p.startMs && t <= p.endMs && minutesOf(e) > 0;
  });
  const perDay: Record<string, number> = {};
  for (const e of created) {
    const d = dayInZone(ms(e.createdAt), p.tz);
    perDay[d] = (perDay[d] ?? 0) + 1;
  }
  const minutesPerDay: Record<string, number> = {};
  for (const e of ended) {
    const d = dayInZone(ms(e.endedAt), p.tz);
    minutesPerDay[d] = (minutesPerDay[d] ?? 0) + minutesOf(e);
  }
  return {
    created,
    ended,
    perDay,
    minutesPerDay,
    minutes: Math.round(ended.reduce((s, e) => s + minutesOf(e), 0)),
  };
}

interface UserInfo {
  label: string;
  email: string;
  plan: string;
}

/** Labels and real plans for up to 300 users, 100 per Clerk call. */
async function lookupUsers(ids: string[]): Promise<Map<string, UserInfo>> {
  const out = new Map<string, UserInfo>();
  const want = [...new Set(ids.filter((id) => id && id.startsWith("user_")))].slice(0, 300);
  if (!want.length) return out;
  try {
    const client = await clerkClient();
    for (let i = 0; i < want.length; i += 100) {
      const chunk = want.slice(i, i + 100);
      const page = await client.users.getUserList({ userId: chunk, limit: 100 });
      for (const u of page.data) {
        const emails = (u.emailAddresses ?? []) as ClerkEmailish[];
        const email = emails[0]?.emailAddress?.toLowerCase() ?? "";
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || email || u.id;
        let plan: string = readPlanFromMetadata(u.publicMetadata);
        // Staff accounts run on the top tier by role, not by paying.
        if (plan === "free" && (isOwnerEmailList(emails) || emails.some((e) => isEnvAdmin(e.emailAddress)))) plan = "staff";
        out.set(u.id, { label: name, email, plan });
      }
    }
  } catch (err) {
    console.warn("[admin-analytics] user lookup failed", err);
  }
  return out;
}

export interface SignUp {
  id: string;
  createdAt: number;
  label: string;
  email: string;
}

/**
 * Accounts Clerk created in [fromMs, toMs], newest first: sign-ups with their
 * full history, including people who never came back (whom the log, which
 * only sees people who arrive, would miss). Null when Clerk cannot be read.
 */
export async function clerkSignUps(fromMs: number, toMs: number): Promise<SignUp[] | null> {
  try {
    const client = await clerkClient();
    const out: SignUp[] = [];
    for (let page = 0, offset = 0; page < 20; page++, offset += 500) {
      const res = await client.users.getUserList({ orderBy: "-created_at", limit: 500, offset });
      for (const u of res.data) {
        if (u.createdAt > toMs || u.createdAt < fromMs) continue;
        const email = u.emailAddresses?.[0]?.emailAddress?.toLowerCase() ?? "";
        out.push({ id: u.id, createdAt: u.createdAt, label: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || email || u.id, email });
      }
      const last = res.data[res.data.length - 1];
      if (res.data.length < 500 || !last || last.createdAt < fromMs) break;
    }
    return out;
  } catch (err) {
    console.warn("[admin-analytics] sign-up lookup failed", err);
    return null;
  }
}

function fig(
  key: FigureKey,
  label: string,
  value: number,
  previous: number,
  source: Figure["source"],
  drill: Figure["drill"],
): Figure {
  return { key, label, value, previous, change: change(value, previous), source, drill };
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

export async function buildAnalytics(p: Period, opts: { now?: number } = {}): Promise<AnalyticsReport> {
  const now = opts.now ?? Date.now();
  const pp = previousPeriod(p);
  const today = utcDay(now);

  // Counters: every UTC day either period touches.
  const hourly = await readHourly(utcDaysBetween(pp.startMs, p.endMs));
  const cur: Folded = foldHourly(hourly, p);
  const prev: Folded = foldHourly(hourly, pp);
  const count = (f: Folded, type: string) => total(f.counts[type]);
  const sum = (f: Folded, type: string) => total(f.sums[type]);

  // Active users per UTC day (the period's dates read as UTC days), plus the
  // 29 days before each period for its trailing MAU; and for cohorts, every
  // week from the first cohort until eight weeks on (or today).
  const cohortFrom = mondayOf(p.days.length > 84 ? addDays(p.to, -83) : p.from);
  const cohortTo = [addDays(p.to, 56), today].sort()[0];
  const dauDays = new Set<string>([
    ...daysFromTo(addDays(pp.from, -29), p.to),
    ...daysFromTo(cohortFrom, cohortTo),
  ]);
  const dau = await readDau([...dauDays]);
  const au = activeUsers(dau, p.days);
  const auPrev = activeUsers(dau, pp.days);

  // Sign-ups: Clerk's creation dates (full history). Should Clerk not answer,
  // the log's own record of first sightings stands in.
  const logSince = await activitySince();
  const cohortFromMs = Date.parse(cohortFrom + "T00:00:00Z");
  const clerk = await clerkSignUps(Math.min(pp.startMs, cohortFromMs), p.endMs);
  let signUps: { cur: number; prev: number; daily: number[]; source: Figure["source"] };
  let newUsers: Record<string, string[]>;
  if (clerk) {
    const inP = clerk.filter((u) => u.createdAt >= p.startMs && u.createdAt <= p.endMs);
    const perDay: Record<string, number> = {};
    for (const u of inP) perDay[dayInZone(u.createdAt, p.tz)] = (perDay[dayInZone(u.createdAt, p.tz)] ?? 0) + 1;
    signUps = {
      cur: inP.length,
      prev: clerk.filter((u) => u.createdAt >= pp.startMs && u.createdAt <= pp.endMs).length,
      daily: series(perDay, p.days),
      source: "store",
    };
    newUsers = {};
    for (const u of clerk) (newUsers[utcDay(u.createdAt)] ??= []).push(u.id);
  } else {
    signUps = { cur: count(cur, "auth.sign_up"), prev: count(prev, "auth.sign_up"), daily: series(cur.counts["auth.sign_up"], p.days), source: "log" };
    newUsers = await readNewUsers(daysFromTo(cohortFrom, p.to));
  }
  // A cohort can only be followed from a week the log saw whole.
  const firstWeek = logSince ? addDays(mondayOf(utcDay(logSince)), utcDay(logSince) === mondayOf(utcDay(logSince)) ? 0 : 7) : null;
  const retention = firstWeek ? weeklyCohorts(newUsers, dau, [cohortFrom, firstWeek].sort()[1], p.to, today) : [];

  // Stores with their own history.
  const events = await eventStore.listAll();
  const m = meetingFigures(events, p);
  const mPrev = meetingFigures(events, pp);
  const liveNow = events.filter((e) => e.state === "live").length;

  const figures: Figure[] = [
    fig("signUps", "New sign-ups", signUps.cur, signUps.prev, signUps.source, signUps.source === "store" ? { kind: "records", metric: "signUps" } : { kind: "logs", type: "auth.sign_up" }),
    fig("signIns", "Sign-ins", count(cur, "auth.sign_in"), count(prev, "auth.sign_in"), "log", { kind: "logs", type: "auth.sign_in" }),
    fig("activeDaily", "Daily active (avg)", au.avgDaily, auPrev.avgDaily, "log", { kind: "logs", type: "" }),
    fig("wau", "Weekly active", au.wau, auPrev.wau, "log", { kind: "logs", type: "" }),
    fig("mau", "Monthly active", au.mau, auPrev.mau, "log", { kind: "logs", type: "" }),
    fig("meetings", "Meetings created", m.created.length, mPrev.created.length, "store", { kind: "records", metric: "meetings" }),
    fig("meetingMinutes", "Meeting minutes", m.minutes, mPrev.minutes, "store", { kind: "records", metric: "meetingMinutes" }),
    fig("joins", "Meeting joins", count(cur, "meeting.joined"), count(prev, "meeting.joined"), "log", { kind: "logs", type: "meeting.joined" }),
    fig("recordingHours", "Recording hours", round1(sum(cur, "recording.finished") / 3600), round1(sum(prev, "recording.finished") / 3600), "log", { kind: "logs", type: "recording.finished" }),
    fig("apiCalls", "Developer API calls", count(cur, "api.call"), count(prev, "api.call"), "log", { kind: "accounts", sort: "apiCalls" }),
    fig("purchases", "Plan purchases", count(cur, "plan.purchased"), count(prev, "plan.purchased"), "log", { kind: "logs", type: "plan.purchased" }),
    fig("conversions", "Free → paid", splitTotals(cur, "plan.purchased").free ?? 0, splitTotals(prev, "plan.purchased").free ?? 0, "log", { kind: "logs", type: "plan.purchased" }),
    fig("cancellations", "Cancellations", count(cur, "plan.cancelled"), count(prev, "plan.cancelled"), "log", { kind: "logs", type: "plan.cancelled" }),
    fig("downgrades", "Plans ended", count(cur, "plan.downgraded"), count(prev, "plan.downgraded"), "log", { kind: "logs", type: "plan.downgraded" }),
    fig("failedAdminSignIns", "Failed admin sign-ins", count(cur, "admin.sign_in_failed"), count(prev, "admin.sign_in_failed"), "log", { kind: "logs", type: "admin.sign_in_failed" }),
  ];

  const daily: Record<string, number[]> = {
    signUps: signUps.daily,
    activeDaily: au.daily,
    meetings: series(m.perDay, p.days),
    meetingMinutes: series(m.minutesPerDay, p.days).map(Math.round),
    joins: series(cur.counts["meeting.joined"], p.days),
    recordingHours: series(cur.sums["recording.finished"], p.days).map((s) => round1(s / 3600)),
    apiCalls: series(cur.counts["api.call"], p.days),
    purchases: series(cur.counts["plan.purchased"], p.days),
    cancellations: series(cur.counts["plan.cancelled"], p.days),
    downgrades: series(cur.counts["plan.downgraded"], p.days),
  };

  const conversions = splitTotals(cur, "plan.purchased").free ?? 0;
  const conversion = {
    conversions,
    purchases: count(cur, "plan.purchased"),
    revenueEsp: sum(cur, "plan.purchased"),
    perSignUp: signUps.cur ? Math.round((conversions / signUps.cur) * 1000) / 10 : null,
    byFromPlan: splitTotals(cur, "plan.purchased"),
  };
  const cancellations = {
    cancelled: count(cur, "plan.cancelled"),
    previousCancelled: count(prev, "plan.cancelled"),
    ended: count(cur, "plan.downgraded"),
    previousEnded: count(prev, "plan.downgraded"),
    endedByPlan: splitTotals(cur, "plan.downgraded"),
  };

  const features = Object.entries(ACTIVITY_TYPES)
    .filter(([, d]) => d.feature)
    .map(([type, d]) => ({
      type,
      label: d.label,
      count: count(cur, type),
      previous: count(prev, type),
      change: change(count(cur, type), count(prev, type)),
    }))
    .sort((a, b) => b.count - a.count);

  // Consumption by account: UTC days of the period.
  const acctDays = await readAccounts(utcDaysBetween(p.startMs, p.endMs));
  const rows = new Map<string, Omit<AccountRow, "label" | "email" | "plan" | "href">>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { id, meetings: 0, meetingMinutes: 0, participants: 0, recordingHours: 0, apiCalls: 0, uploadMB: 0 }));
    return r;
  };
  for (const fields of Object.values(acctDays)) {
    for (const [field, n] of Object.entries(fields)) {
      const cut = field.lastIndexOf("|");
      const id = field.slice(0, cut);
      const metric = field.slice(cut + 1);
      if (!id) continue;
      const r = row(id);
      if (metric === "participants") r.participants += n;
      else if (metric === "recordingSeconds") r.recordingHours += n / 3600;
      else if (metric === "apiCalls") r.apiCalls += n;
      else if (metric === "uploadBytes") r.uploadMB += n / 1_048_576;
    }
  }
  for (const e of m.created) if (e.ownerUserId) row(e.ownerUserId).meetings++;
  for (const e of m.ended) if (e.ownerUserId) row(e.ownerUserId).meetingMinutes += minutesOf(e);

  const ranked = [...rows.values()]
    .sort((a, b) => b.meetings + b.participants + b.apiCalls - (a.meetings + a.participants + a.apiCalls) || b.meetingMinutes - a.meetingMinutes)
    .slice(0, 200);
  const owners = [...new Set(m.created.map((e) => e.ownerUserId).filter(Boolean))];
  const info = await lookupUsers([...ranked.map((r) => r.id), ...owners]);
  const accounts: AccountRow[] = ranked.map((r) => ({
    ...r,
    meetingMinutes: Math.round(r.meetingMinutes),
    recordingHours: round1(r.recordingHours),
    uploadMB: round1(r.uploadMB),
    label: info.get(r.id)?.label ?? r.id,
    email: info.get(r.id)?.email ?? "",
    plan: info.get(r.id)?.plan ?? "unknown",
    href: accountHref(r.id),
  }));

  // Plans of the people who created meetings in the period, from their accounts.
  const planCounts = new Map<string, { owners: Set<string>; meetings: number }>();
  for (const e of m.created) {
    const plan = info.get(e.ownerUserId)?.plan ?? "unknown";
    let c = planCounts.get(plan);
    if (!c) planCounts.set(plan, (c = { owners: new Set(), meetings: 0 }));
    c.meetings++;
    if (e.ownerUserId) c.owners.add(e.ownerUserId);
  }
  const plans = [...planCounts.entries()]
    .map(([plan, c]) => ({ plan, owners: c.owners.size, meetings: c.meetings }))
    .sort((a, b) => b.meetings - a.meetings);

  const pick = (x: Period) => ({ from: x.from, to: x.to, tz: x.tz, startMs: x.startMs, endMs: x.endMs });
  return {
    period: pick(p),
    previous: pick(pp),
    logSince,
    cohortsFrom: firstWeek,
    days: p.days,
    figures,
    daily,
    retention,
    conversion,
    cancellations,
    features,
    accounts,
    plans,
    liveNow,
  };
}

/** The records behind a store-backed figure. Titles only for events:read. */
export async function meetingRecords(p: Period, metric: "meetings" | "meetingMinutes", withTitles: boolean) {
  const events = await eventStore.listAll();
  const m = meetingFigures(events, p);
  const list = metric === "meetings" ? m.created : m.ended;
  const info = await lookupUsers(list.map((e) => e.ownerUserId));
  return list
    .map((e) => ({
      id: e.id,
      slug: e.slug,
      title: withTitles ? e.name : undefined,
      owner: info.get(e.ownerUserId)?.label ?? e.ownerUserId,
      ownerId: e.ownerUserId,
      plan: info.get(e.ownerUserId)?.plan ?? "unknown",
      createdAt: ms(e.createdAt) || null,
      startedAt: ms(e.startedAt) || null,
      endedAt: ms(e.endedAt) || null,
      minutes: Math.round(minutesOf(e)),
      state: e.state,
    }))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

// The reports as tables, for CSV and Excel.
export const REPORTS = ["summary", "daily", "features", "retention", "accounts", "plans"] as const;
export type ReportName = (typeof REPORTS)[number];

export function analyticsTables(r: AnalyticsReport): Record<ReportName, Table> {
  const zone = r.period.tz;
  const dailyKeys = Object.keys(r.daily);
  const weeks = Math.max(0, ...r.retention.map((c) => c.retained.length));
  return {
    summary: {
      name: "Summary",
      columns: [
        { header: "Figure", key: "label", width: 28 },
        { header: `This period (${r.period.from} to ${r.period.to}, ${zone})`, key: "value", width: 22 },
        { header: `Previous period (${r.previous.from} to ${r.previous.to})`, key: "previous", width: 22 },
        { header: "Change %", key: "change", width: 10 },
        { header: "Source", key: "source", width: 34 },
      ],
      rows: r.figures.map((f) => ({
        ...f,
        change: f.change ?? "",
        source: f.source === "store" ? "Meeting store (full history)" : "Activity log (from its first day)",
      })),
    },
    daily: {
      name: "Daily",
      columns: [{ header: `Day (${zone}; active users by UTC day)`, key: "day", width: 14 }, ...dailyKeys.map((k) => ({ header: k, key: k, width: 14 }))],
      rows: r.days.map((day, i) => Object.fromEntries([["day", day], ...dailyKeys.map((k) => [k, r.daily[k][i] ?? 0])])),
    },
    features: {
      name: "Features",
      columns: [
        { header: "Feature", key: "label", width: 24 },
        { header: "Event type", key: "type", width: 22 },
        { header: "Uses", key: "count" },
        { header: "Previous period", key: "previous", width: 16 },
        { header: "Change %", key: "change" },
      ],
      rows: r.features.map((f) => ({ ...f, change: f.change ?? "" })),
    },
    retention: {
      name: "Retention",
      columns: [
        { header: "Cohort week (UTC, Monday)", key: "week", width: 24 },
        { header: "Signed up", key: "size" },
        ...Array.from({ length: weeks }, (_, k) => ({ header: `Week ${k}`, key: `w${k}` })),
      ],
      rows: r.retention.map((c) => ({ week: c.week, size: c.size, ...Object.fromEntries(c.retained.map((n, k) => [`w${k}`, n])) })),
    },
    accounts: {
      name: "Accounts",
      columns: [
        { header: "Account", key: "label", width: 26 },
        { header: "Email", key: "email", width: 28 },
        { header: "User id", key: "id", width: 34 },
        { header: "Plan", key: "plan" },
        { header: "Meetings", key: "meetings" },
        { header: "Meeting minutes", key: "meetingMinutes", width: 16 },
        { header: "Participants", key: "participants", width: 13 },
        { header: "Recording hours", key: "recordingHours", width: 16 },
        { header: "API calls", key: "apiCalls" },
        { header: "Uploads (MB)", key: "uploadMB", width: 13 },
      ],
      rows: r.accounts as unknown as Array<Record<string, unknown>>,
    },
    plans: {
      name: "Plans",
      columns: [
        { header: "Plan (on the account)", key: "plan", width: 22 },
        { header: "Meeting owners", key: "owners", width: 16 },
        { header: "Meetings created", key: "meetings", width: 16 },
      ],
      rows: r.plans,
    },
  };
}
