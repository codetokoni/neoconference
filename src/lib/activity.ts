// src/lib/activity.ts
//
// The platform activity log: what people did across the whole platform —
// sign-ins, sign-ups, meetings, joins, recordings, features used, API calls,
// purchases. Read by /admin/analytics and /admin/logs. Separate from the
// admin audit (src/lib/admin/audit.ts: what administrators did) and the
// meeting permission log (src/lib/auditLog.ts: every allow/deny decision).
//
// EDGE-SAFE ON PURPOSE: middleware imports markActive(). Only Web APIs and
// the Upstash client in @/lib/kv; no Node-only import here.
//
// Keys (days are UTC, YYYY-MM-DD):
//
//   neo:act:log:<day>    list    raw events, newest first        TTL retention (default 90 d)
//   neo:act:u:<uid>      list    one person's newest 500 events  TTL retention
//   neo:act:hr:<day>     hash    "<type>|<HH>" -> count, "<type>|<HH>|sum" -> amount,
//                                "<type>#<value>|<HH>" -> count split by one prop   TTL 400 d
//   neo:act:dau:<day>    set     user ids active that day        TTL 400 d
//   neo:act:new:<day>    set     user ids who signed up that day TTL 400 d
//   neo:act:acct:<day>   hash    "<account>|<metric>" -> amount  TTL 400 d
//   neo:act:users        set     every user id seen (first sight = sign-up check)
//   neo:act:since        string  epoch ms of the first event recorded
//
// Cost: one record() is 3–7 Redis commands, sent as one HTTP request
// (@/lib/kv auto-pipelines commands issued together). EXPIRE is sent once per
// key per server instance, not per event. markActive() is at most one SADD
// per person per day per instance.
//
// Every write is awaited by its caller (Vercel can drop work left running
// after the response) and none can fail the request it records: errors are
// logged and swallowed, and a write that takes longer than WRITE_BUDGET_MS is
// abandoned rather than waited for.

import { kv } from "@/lib/kv";
import { ACTIVITY_TYPES } from "@/lib/activityTypes";

export { ACTIVITY_TYPES, type AccountMetric } from "@/lib/activityTypes";

export type Severity = "info" | "warn" | "error";
export type PropValue = string | number | boolean | null;

export interface ActivityEvent {
  id: string;
  ts: number;
  type: string;
  userId?: string;
  /** Whose usage this counts against (a meeting's owner, an API key's owner). */
  account?: string;
  severity: Severity;
  props?: Record<string, PropValue>;
}

export const ROLLUP_TTL_S = 400 * 86_400;
const USER_LIST_MAX = 500;
const WRITE_BUDGET_MS = 1500;
const DAY_MS = 86_400_000;

export const K = {
  log: (day: string) => `neo:act:log:${day}`,
  user: (uid: string) => `neo:act:u:${uid}`,
  hourly: (day: string) => `neo:act:hr:${day}`,
  dau: (day: string) => `neo:act:dau:${day}`,
  newUsers: (day: string) => `neo:act:new:${day}`,
  accounts: (day: string) => `neo:act:acct:${day}`,
  users: "neo:act:users",
  since: "neo:act:since",
};

/** Raw-event retention in days: ACTIVITY_RETENTION_DAYS, 1–400, default 90. */
export function retentionDays(): number {
  const n = Number(process.env.ACTIVITY_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.min(400, Math.floor(n)) : 90;
}

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Every UTC day touching [fromMs, toMs], oldest first. */
export function utcDaysBetween(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  const start = Date.parse(utcDay(fromMs) + "T00:00:00Z");
  for (let t = start; t <= toMs; t += DAY_MS) out.push(utcDay(t));
  return out;
}

// EXPIRE once per key per instance: the TTL is reset by the first write of the
// day on each instance, which is all a day-keyed key needs.
const expired = new Set<string>();
function expireOnce(key: string, seconds: number): Promise<unknown> | null {
  if (expired.has(key)) return null;
  if (expired.size > 5000) expired.clear();
  expired.add(key);
  return kv.expire(key, seconds);
}

/** Tests only: forget which keys already had their TTL set. */
export function __resetActivityMemo(): void {
  expired.clear();
  activeMemo.clear();
  onceMemo.clear();
}

function cleanProps(props: Record<string, unknown> | undefined): Record<string, PropValue> | undefined {
  if (!props) return undefined;
  const out: Record<string, PropValue> = {};
  let n = 0;
  for (const [k, v] of Object.entries(props)) {
    if (n >= 20) break;
    if (v === undefined) continue;
    if (v === null || typeof v === "boolean") out[k] = v;
    else if (typeof v === "number") out[k] = Number.isFinite(v) ? v : null;
    else out[k] = String(v).slice(0, 200);
    n++;
  }
  return n ? out : undefined;
}

function newId(ts: number): string {
  const r = new Uint8Array(5);
  crypto.getRandomValues(r);
  return ts.toString(36) + "-" + Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `work`'s result, or undefined if it takes longer than WRITE_BUDGET_MS. */
async function withinBudget<T>(work: Promise<T>, what: string): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), WRITE_BUDGET_MS);
  });
  try {
    const r = await Promise.race([work, late]);
    if (r === LATE) {
      console.warn("[activity] write abandoned after", WRITE_BUDGET_MS, "ms:", what);
      return undefined;
    }
    return r as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const LATE = Symbol("late");

export interface RecordOptions {
  userId?: string | null;
  account?: string | null;
  severity?: Severity;
  props?: Record<string, unknown>;
  /** When it happened, if not now (a webhook's own timestamp). */
  ts?: number;
  /**
   * For events that fire in bursts (a translated caption line): record once
   * per this key per hour on this instance. Counts then read as "sessions".
   */
  oncePerHour?: string;
}

const onceMemo = new Set<string>();

/**
 * Record one event. Never throws and never takes longer than
 * WRITE_BUDGET_MS. Returns the event as written, or null if it was not.
 */
export async function record(type: string, opts: RecordOptions = {}): Promise<ActivityEvent | null> {
  try {
    const ts = opts.ts && Number.isFinite(opts.ts) ? opts.ts : Date.now();
    if (opts.oncePerHour) {
      const memo = `${type}|${opts.oncePerHour}|${Math.floor(ts / 3_600_000)}`;
      if (onceMemo.has(memo)) return null;
      if (onceMemo.size > 20_000) onceMemo.clear();
      onceMemo.add(memo);
    }
    const def = ACTIVITY_TYPES[type] ?? { label: type };
    const userId = opts.userId || undefined;
    const account = opts.account || undefined;
    const props = cleanProps(opts.props);
    const event: ActivityEvent = {
      id: newId(ts),
      ts,
      type,
      ...(userId ? { userId } : {}),
      ...(account ? { account } : {}),
      severity: opts.severity ?? "info",
      ...(props ? { props } : {}),
    };
    const day = utcDay(ts);
    const hh = new Date(ts).toISOString().slice(11, 13);
    const retentionS = retentionDays() * 86_400;
    const ops: Array<Promise<unknown> | null> = [];

    if (!def.noRaw) {
      const line = JSON.stringify(event);
      ops.push(kv.lpush(K.log(day), line), expireOnce(K.log(day), retentionS));
      if (userId) {
        ops.push(kv.lpush(K.user(userId), line), kv.ltrim(K.user(userId), 0, USER_LIST_MAX - 1));
        ops.push(expireOnce(K.user(userId), retentionS));
      }
    }
    ops.push(kv.hincrby(K.hourly(day), `${type}|${hh}`, 1));
    const amount = def.amount ? Number(props?.[def.amount]) : NaN;
    if (Number.isFinite(amount) && amount !== 0) ops.push(kv.hincrby(K.hourly(day), `${type}|${hh}|sum`, Math.round(amount)));
    const split = def.splitBy ? props?.[def.splitBy] : undefined;
    if (split != null && split !== "") ops.push(kv.hincrby(K.hourly(day), `${type}#${String(split).slice(0, 40)}|${hh}`, 1));
    ops.push(expireOnce(K.hourly(day), ROLLUP_TTL_S));

    if (userId) ops.push(kv.sadd(K.dau(day), userId), expireOnce(K.dau(day), ROLLUP_TTL_S));
    if (account && def.accountMetric) {
      const by = def.accountMetric.amount ? Number(props?.[def.accountMetric.amount]) : 1;
      if (Number.isFinite(by) && by > 0) {
        ops.push(kv.hincrby(K.accounts(day), `${account}|${def.accountMetric.metric}`, Math.round(by)));
        ops.push(expireOnce(K.accounts(day), ROLLUP_TTL_S));
      }
    }
    if (!expired.has(K.since)) {
      expired.add(K.since);
      ops.push(kv.set(K.since, ts, { nx: true }));
    }
    await withinBudget(Promise.all(ops.filter(Boolean)), type);
    return event;
  } catch (err) {
    console.error("[activity] record failed", type, err);
    return null;
  }
}

type CreatedAt = number | null | undefined | (() => Promise<number | null | undefined>);

/**
 * A person showed up: mark them active today, and on first sight ever note
 * them as a user (see noteUser). Called from middleware on signed-in
 * requests, so it is memoised per instance — one round trip per person per
 * day per instance — and never throws.
 */
const activeMemo = new Set<string>();
export async function markActive(userId: string, createdAt?: CreatedAt, now = Date.now()): Promise<void> {
  if (!userId) return;
  const day = utcDay(now);
  const memo = `${day}|${userId}`;
  if (activeMemo.has(memo)) return;
  if (activeMemo.size > 20_000) activeMemo.clear();
  activeMemo.add(memo);
  try {
    let firstSight = false;
    await withinBudget(
      Promise.all([
        kv.sadd(K.dau(day), userId),
        expireOnce(K.dau(day), ROLLUP_TTL_S),
        createdAt === undefined ? null : kv.sadd(K.users, userId).then((n) => (firstSight = Number(n) === 1)),
      ].filter(Boolean)),
      "markActive",
    );
    if (firstSight) await firstSeen(userId, createdAt);
  } catch (err) {
    activeMemo.delete(memo);
    console.error("[activity] markActive failed", err);
  }
}

async function firstSeen(userId: string, createdAt: CreatedAt, props?: Record<string, unknown>): Promise<void> {
  // Asked only on first sight, so a Clerk lookup here happens once per person.
  const when = typeof createdAt === "function" ? await withinBudget(createdAt().catch(() => null), "createdAt") : createdAt;
  const ts = when && Number.isFinite(when) && when > 0 ? when : Date.now();
  const day = utcDay(ts);
  await withinBudget(
    Promise.all([kv.sadd(K.newUsers(day), userId), expireOnce(K.newUsers(day), ROLLUP_TTL_S)].filter(Boolean)),
    "firstSeen",
  );
  // Only a recent sign-up goes in the log and the counters; an old account
  // seen for the first time is in its cohort's set above, nothing more.
  if (Date.now() - ts < 2 * DAY_MS) await record("auth.sign_up", { userId, ts, props });
}

/**
 * First sight of a user. `createdAt` (Clerk's) decides the day they count as
 * a sign-up, so someone who registered before this log existed is counted on
 * their real day, not on the day they next happened to sign in. Idempotent:
 * the second call for the same user does nothing.
 */
export async function noteUser(userId: string, createdAt: CreatedAt, props?: Record<string, unknown>): Promise<boolean> {
  if (!userId) return false;
  try {
    const added = Number(await withinBudget(kv.sadd(K.users, userId), "noteUser"));
    if (added !== 1) return false;
    await firstSeen(userId, createdAt, props);
    return true;
  } catch (err) {
    console.error("[activity] noteUser failed", err);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

function parse(raw: unknown): ActivityEvent | null {
  if (raw && typeof raw === "object") return raw as ActivityEvent;
  try {
    return JSON.parse(String(raw)) as ActivityEvent;
  } catch {
    return null;
  }
}

function numHash(h: Record<string, unknown> | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

export async function readHourly(days: string[]): Promise<Record<string, Record<string, number>>> {
  const raw = await Promise.all(days.map((d) => kv.hgetall<Record<string, unknown>>(K.hourly(d))));
  return Object.fromEntries(days.map((d, i) => [d, numHash(raw[i])]));
}

export async function readAccounts(days: string[]): Promise<Record<string, Record<string, number>>> {
  const raw = await Promise.all(days.map((d) => kv.hgetall<Record<string, unknown>>(K.accounts(d))));
  return Object.fromEntries(days.map((d, i) => [d, numHash(raw[i])]));
}

async function readSets(keyOf: (d: string) => string, days: string[]): Promise<Record<string, string[]>> {
  const raw = await Promise.all(days.map((d) => kv.smembers(keyOf(d))));
  return Object.fromEntries(days.map((d, i) => [d, ((raw[i] ?? []) as unknown[]).map(String)]));
}
export const readDau = (days: string[]) => readSets(K.dau, days);
export const readNewUsers = (days: string[]) => readSets(K.newUsers, days);

/** When the log started (epoch ms), or null before the first event. */
export async function activitySince(): Promise<number | null> {
  try {
    const v = Number(await kv.get(K.since));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** One person's newest events (at most 500 are kept, for the retention period). */
export async function listUserActivity(userId: string, opts: { limit?: number; before?: number } = {}): Promise<ActivityEvent[]> {
  if (!userId) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 50, USER_LIST_MAX));
  const raw = ((await kv.lrange(K.user(userId), 0, USER_LIST_MAX - 1)) ?? []) as unknown[];
  // By when it happened: a sign-up is written at sign-in but dated at sign-up.
  return raw
    .map(parse)
    .filter((e): e is ActivityEvent => !!e && !(opts.before && e.ts >= opts.before))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

export interface ActivityQuery {
  /** Matches user id or account (substring). */
  user?: string;
  /** Type prefix: "meeting." or "auth.sign_in". */
  type?: string;
  severity?: Severity;
  /** Free text across the whole event. */
  q?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

/** Most events a search reads before it stops and says the total is a floor. */
export const SCAN_CAP = 20_000;

/** Raw events matching `q`, newest first. Reads day by day from `to` back to `from`. */
export async function listActivity(q: ActivityQuery = {}): Promise<{ items: ActivityEvent[]; total: number; truncated: boolean }> {
  const limit = Math.max(1, Math.min(q.limit ?? 50, 5000));
  const offset = Math.max(0, q.offset ?? 0);
  const now = Date.now();
  const to = Math.min(q.to ?? now, now);
  const from = Math.max(q.from ?? to - retentionDays() * DAY_MS, to - 400 * DAY_MS);
  const days = utcDaysBetween(from, to).reverse();
  const user = q.user?.toLowerCase();
  const text = q.q?.toLowerCase();
  const matches: ActivityEvent[] = [];
  let scanned = 0;
  let truncated = false;
  for (const day of days) {
    if (scanned >= SCAN_CAP) {
      truncated = true;
      break;
    }
    const raw = ((await kv.lrange(K.log(day), 0, SCAN_CAP - scanned - 1)) ?? []) as unknown[];
    scanned += raw.length;
    for (const r of raw) {
      const e = parse(r);
      if (!e) continue;
      if (e.ts < from || e.ts > to) continue;
      if (user && !`${e.userId ?? ""} ${e.account ?? ""}`.toLowerCase().includes(user)) continue;
      if (q.type && !e.type.startsWith(q.type)) continue;
      if (q.severity && e.severity !== q.severity) continue;
      if (text && !JSON.stringify(e).toLowerCase().includes(text)) continue;
      matches.push(e);
    }
  }
  matches.sort((a, b) => b.ts - a.ts);
  return { items: matches.slice(offset, offset + limit), total: matches.length, truncated };
}

export const activity = { record, markActive, noteUser };
