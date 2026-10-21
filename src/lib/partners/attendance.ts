// src/lib/partners/attendance.ts — prayer sessions and who was connected,
// for partner zones (src/lib/partners). The timer a visitor sees and the
// zone reports are both computed from what is stored here
// (attendanceMath.ts holds the counting rules).
//
// A prayer session is one opening of the zone's room: it starts with the
// first connection to an empty room and ends when LiveKit closes the room
// (room_finished), or — if that event never comes — once nothing has
// happened in it for STALE_SESSION_MS. Its duration runs from its first
// connection to its last departure.
//
// Connections come from LiveKit only: its webhook (join, leave), and the
// embed page's heartbeat, which LiveKit itself confirms before a new
// connection is opened from it (verifyConnection). A browser can keep a
// connection's last-seen time fresh; it cannot invent one.
//
// KV (all timestamps epoch ms, UTC):
//   neo:pz:id:<identity>                      who a room identity is { integrationId, zoneId, ext, name, verified }
//   neo:pz:<integ>:<ZONE>:cur                 the zone's current session id
//   neo:pz:sess:<sessionId>                   hash: the session
//   neo:pz:sess:<sessionId>:people            set of identities seen in it
//   neo:pz:att:<sessionId>:<identity>         hash: ext, name, verified, and per connection
//                                             s:<sid> start, e:<sid> end, l:<sid> last seen
//   neo:pz:sid:<sid>                          which session a connection belongs to
//   neo:pz:<integ>:<ZONE>:sessions / :ended   zsets of session ids by start / by end
//   neo:pz:<integ>:u:<identity>               zset of the sessions a person attended, by start
//   neo:pz:<integ>:<ZONE>:ver                 bumped on every change (report ETags)
// Separate fields per connection keep a heartbeat and a leave from
// overwriting each other: a heartbeat writes only l:, a leave only e:.

import { randomBytes } from "node:crypto";
import { kv } from "@/lib/kv";
import { connectionEnd, countedIntervals, mergeIntervals, totalMs, type ConnectionRecord, type Interval } from "@/lib/partners/attendanceMath";

export const STALE_SESSION_MS = 10 * 60_000;
const RETENTION_S = 400 * 24 * 60 * 60;
const SID_TTL_S = 3 * 24 * 60 * 60;
const MAX_CONNECTIONS = 300;

const COMPARE_AND_SET = `-- compare-and-set: KEYS[1] becomes ARGV[2] only if it still holds ARGV[1]
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0`;

export const AK = {
  identity: (identity: string) => `neo:pz:id:${identity}`,
  current: (integ: string, zone: string) => `neo:pz:${integ}:${zone}:cur`,
  session: (id: string) => `neo:pz:sess:${id}`,
  people: (id: string) => `neo:pz:sess:${id}:people`,
  person: (id: string, identity: string) => `neo:pz:att:${id}:${identity}`,
  sid: (sid: string) => `neo:pz:sid:${sid}`,
  byStart: (integ: string, zone: string) => `neo:pz:${integ}:${zone}:sessions`,
  byEnd: (integ: string, zone: string) => `neo:pz:${integ}:${zone}:ended`,
  personSessions: (integ: string, identity: string) => `neo:pz:${integ}:u:${identity}`,
  version: (integ: string, zone: string) => `neo:pz:${integ}:${zone}:ver`,
};

export type PrayerSession = {
  id: string;
  integrationId: string;
  zoneId: string;
  eventId: string;
  room: string;
  startedAt: number;
  lastActivity: number;
  lastLeave?: number;
  endedAt?: number;
};

export type PersonRecord = {
  identity: string;
  ext: string;
  name: string;
  verified: boolean;
  connections: Record<string, ConnectionRecord>;
};

export type IdentityInfo = { integrationId: string; zoneId: string; ext: string; name: string; verified: boolean };

/** Where a zone's room is, for the routes and the webhook. */
export type ZoneRoom = { integrationId: string; zoneId: string; eventId: string; room: string };

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/* ------------------------------- identities ------------------------------- */

/** Written when a token is made (src/lib/partners/join.ts): the webhook only knows the room identity. */
export async function rememberIdentity(identity: string, info: IdentityInfo): Promise<void> {
  await kv.set(AK.identity(identity), info, { ex: RETENTION_S });
}

export async function identityInfo(identity: string): Promise<IdentityInfo | null> {
  return (await kv.get<IdentityInfo>(AK.identity(identity))) ?? null;
}

/* -------------------------------- sessions -------------------------------- */

function parseSession(h: Record<string, unknown> | null): PrayerSession | null {
  if (!h || typeof h.id !== "string") return null;
  return {
    id: h.id,
    integrationId: String(h.integrationId ?? ""),
    zoneId: String(h.zoneId ?? ""),
    eventId: String(h.eventId ?? ""),
    room: String(h.room ?? ""),
    startedAt: num(h.startedAt) ?? 0,
    lastActivity: num(h.lastActivity) ?? num(h.startedAt) ?? 0,
    lastLeave: num(h.lastLeave),
    endedAt: num(h.endedAt),
  };
}

export async function getSession(id: string): Promise<PrayerSession | null> {
  return parseSession((await kv.hgetall<Record<string, unknown>>(AK.session(id))) ?? null);
}

export async function getSessions(ids: string[]): Promise<PrayerSession[]> {
  const all = await Promise.all(ids.map((id) => getSession(id)));
  return all.filter((s): s is PrayerSession => !!s);
}

function isStale(s: PrayerSession, now: number): boolean {
  return s.endedAt == null && now - s.lastActivity > STALE_SESSION_MS;
}

async function bump(integ: string, zone: string): Promise<void> {
  await kv.incr(AK.version(integ, zone));
}

/** Ends a session once: at its last departure (or last activity), never before it began. */
export async function closeSession(s: PrayerSession, at?: number): Promise<PrayerSession> {
  if (s.endedAt != null) return s;
  const endedAt = Math.max(s.startedAt, at ?? Math.max(s.lastLeave ?? 0, s.lastActivity));
  const won = await kv.hsetnx(AK.session(s.id), "endedAt", endedAt);
  const final = won ? endedAt : (num(await kv.hget(AK.session(s.id), "endedAt")) ?? endedAt);
  await kv.zadd(AK.byEnd(s.integrationId, s.zoneId), { score: final, member: s.id });
  await bump(s.integrationId, s.zoneId);
  return { ...s, endedAt: final };
}

/** The zone's open session, if it has one that is still alive. */
export async function currentSession(integ: string, zone: string, now = Date.now()): Promise<PrayerSession | null> {
  const id = await kv.get<string>(AK.current(integ, zone));
  if (!id) return null;
  const s = await getSession(String(id));
  if (!s || s.endedAt != null) return null;
  if (isStale(s, now)) {
    await closeSession(s);
    return null;
  }
  return s;
}

/**
 * The zone's open session, starting one if there is none. Two first
 * connections at once start one session: the pointer moves by
 * set-if-absent or compare-and-set, and the loser reads the winner's.
 */
export async function ensureSession(z: ZoneRoom, at: number, now = Date.now()): Promise<PrayerSession> {
  const ptr = AK.current(z.integrationId, z.zoneId);
  for (let i = 0; i < 8; i++) {
    const curId = await kv.get<string>(ptr);
    if (curId) {
      const cur = await getSession(String(curId));
      if (cur && cur.endedAt == null && !isStale(cur, now)) return cur;
      if (cur && cur.endedAt == null) await closeSession(cur);
    }
    const s: PrayerSession = {
      id: `ps_${randomBytes(8).toString("hex")}`,
      integrationId: z.integrationId,
      zoneId: z.zoneId,
      eventId: z.eventId,
      room: z.room,
      startedAt: at,
      lastActivity: at,
    };
    const moved = curId
      ? Number(await kv.eval(COMPARE_AND_SET, [ptr], [String(curId), s.id])) === 1
      : (await kv.set(ptr, s.id, { nx: true })) === "OK";
    if (!moved) continue;
    await kv.hset(AK.session(s.id), s);
    await kv.expire(AK.session(s.id), RETENTION_S);
    await kv.zadd(AK.byStart(z.integrationId, z.zoneId), { score: s.startedAt, member: s.id });
    await bump(z.integrationId, z.zoneId);
    return s;
  }
  throw new Error("partner attendance: could not start a session");
}

async function touch(s: PrayerSession, at: number, leave = false): Promise<void> {
  const fields: Record<string, number> = {};
  if (at > s.lastActivity) fields.lastActivity = at;
  if (leave && at > (s.lastLeave ?? 0)) fields.lastLeave = at;
  // A connection confirmed with an earlier start than the session's (LiveKit's joinedAt) moves the start back.
  if (at < s.startedAt && !leave) {
    fields.startedAt = at;
    await kv.zadd(AK.byStart(s.integrationId, s.zoneId), { score: at, member: s.id });
  }
  if (Object.keys(fields).length) await kv.hset(AK.session(s.id), fields);
}

/** The session's room closed (LiveKit room_finished). */
export async function roomClosed(z: ZoneRoom, now = Date.now()): Promise<void> {
  const id = await kv.get<string>(AK.current(z.integrationId, z.zoneId));
  if (!id) return;
  const s = await getSession(String(id));
  if (s && s.endedAt == null) await closeSession(s, Math.min(now, Math.max(s.lastLeave ?? 0, s.lastActivity)));
}

/** Anyone else in the room (the host on NeoLinguaMeet itself): keeps the session's own clock, no prayer time. */
export async function roomActivity(z: ZoneRoom, at: number, leave: boolean, now = Date.now()): Promise<void> {
  if (leave) {
    const s = await currentSession(z.integrationId, z.zoneId, now);
    if (s) await touch(s, at, true);
    return;
  }
  await touch(await ensureSession(z, at, now), at);
}

/* ------------------------------- connections ------------------------------ */

export function parsePerson(identity: string, h: Record<string, unknown> | null): PersonRecord | null {
  if (!h) return null;
  const connections: Record<string, ConnectionRecord> = {};
  for (const [k, v] of Object.entries(h)) {
    const m = /^([sel]):(.+)$/.exec(k);
    const n = num(v);
    if (!m || n == null) continue;
    const c = (connections[m[2]] ??= { s: n });
    if (m[1] === "s") c.s = n;
    else if (m[1] === "e") c.e = n;
    else c.l = n;
  }
  for (const sid of Object.keys(connections)) if (h[`s:${sid}`] == null) delete connections[sid];
  return {
    identity,
    ext: String(h.ext ?? ""),
    name: String(h.name ?? ""),
    verified: h.verified === true || h.verified === "true",
    connections,
  };
}

export async function getPerson(sessionId: string, identity: string): Promise<PersonRecord | null> {
  return parsePerson(identity, (await kv.hgetall<Record<string, unknown>>(AK.person(sessionId, identity))) ?? null);
}

/** LiveKit confirmed a partner visitor's connection. Idempotent per connection. */
export async function connectionOpened(z: ZoneRoom, identity: string, sid: string, at: number, who: IdentityInfo, now = Date.now()): Promise<PrayerSession | null> {
  const mapped = await kv.get<string>(AK.sid(sid));
  let s = mapped ? await getSession(String(mapped)) : null;
  if (!s) {
    s = await ensureSession(z, at, now);
    const claimed = (await kv.set(AK.sid(sid), s.id, { nx: true, ex: SID_TTL_S })) === "OK";
    if (!claimed) s = (await getSession(String(await kv.get<string>(AK.sid(sid))))) ?? s;
  }
  const key = AK.person(s.id, identity);
  if ((await kv.hlen(key)) > MAX_CONNECTIONS * 3) return s;
  await kv.hset(key, { ext: who.ext, name: who.name, verified: who.verified });
  await kv.hsetnx(key, `s:${sid}`, at);
  // Last seen: when LiveKit confirmed it. Heartbeats move it on from there.
  const last = num(await kv.hget(key, `l:${sid}`));
  if (last == null || at > last) await kv.hset(key, { [`l:${sid}`]: at });
  await kv.expire(key, RETENTION_S);
  await kv.sadd(AK.people(s.id), identity);
  await kv.expire(AK.people(s.id), RETENTION_S);
  await kv.zadd(AK.personSessions(z.integrationId, identity), { score: s.startedAt, member: s.id });
  await kv.expire(AK.personSessions(z.integrationId, identity), RETENTION_S);
  await touch(s, at);
  await bump(z.integrationId, z.zoneId);
  return s;
}

/** LiveKit says the connection is gone. The first end recorded stands. */
export async function connectionClosed(identity: string, sid: string, at: number): Promise<void> {
  const id = await kv.get<string>(AK.sid(sid));
  if (!id) return;
  const s = await getSession(String(id));
  if (!s) return;
  const key = AK.person(s.id, identity);
  if ((await kv.hget(key, `s:${sid}`)) == null) return;
  await kv.hsetnx(key, `e:${sid}`, at);
  await touch(s, at, true);
  await bump(s.integrationId, s.zoneId);
}

export type HeartbeatResult = "ok" | "unknown_connection" | "ended";

/**
 * The embed page says connection `sid` is still on. Fresh connections are
 * believed; one not heard from for a while, or one never seen, is first
 * confirmed with LiveKit (`verify` answers LiveKit's joinedAt in ms for this
 * identity's connection `sid`, or null if it is not connected).
 */
export async function heartbeat(
  z: ZoneRoom,
  identity: string,
  sid: string,
  who: IdentityInfo,
  verify: () => Promise<number | null>,
  now = Date.now(),
): Promise<HeartbeatResult> {
  const id = await kv.get<string>(AK.sid(sid));
  if (id) {
    const key = AK.person(String(id), identity);
    const h = (await kv.hgetall<Record<string, unknown>>(key)) ?? null;
    const c = parsePerson(identity, h)?.connections[sid];
    // Another person's connection id: nothing to do with this visitor.
    if (!c) return "unknown_connection";
    if (c.e != null) return "ended";
    const s = await getSession(String(id));
    if (!s || s.endedAt != null) return "ended";
    const last = c.l ?? c.s;
    if (now - last > 30_000) {
      // Quiet for a while: only LiveKit can say it is still connected.
      const joined = await verify();
      if (joined == null) {
        await kv.hsetnx(key, `e:${sid}`, last);
        await touch(s, last, true);
        await bump(s.integrationId, s.zoneId);
        return "ended";
      }
    }
    await kv.hset(key, { [`l:${sid}`]: now });
    await touch(s, now);
    return "ok";
  }
  const joined = await verify();
  if (joined == null) return "unknown_connection";
  const s = await connectionOpened(z, identity, sid, Math.min(joined, now), who, now);
  if (!s) return "unknown_connection";
  await kv.hset(AK.person(s.id, identity), { [`l:${sid}`]: now });
  await touch(s, now);
  return "ok";
}

/* ------------------------------ what counts ------------------------------- */

/** A person's connections in one session as intervals (ends worked out as of `now`). */
export function personIntervals(p: PersonRecord, s: PrayerSession, now: number): { intervals: Interval[]; connected: boolean } {
  let connected = false;
  const intervals: Interval[] = [];
  for (const c of Object.values(p.connections)) {
    const { end, open } = connectionEnd(c, now, s.endedAt);
    if (open) connected = true;
    intervals.push({ start: c.s, end });
  }
  return { intervals, connected };
}

export type TimerSummary = {
  sessionId: string | null;
  sessionStartedAt: number | null;
  /** Counted prayer time as of serverNow. */
  seconds: number;
  connected: boolean;
  serverNow: number;
};

/** What the visitor's own timer shows: their counted time in the zone's current session. */
export async function timerSummary(integ: string, zone: string, identity: string, now = Date.now()): Promise<TimerSummary> {
  const s = await currentSession(integ, zone, now);
  if (!s) return { sessionId: null, sessionStartedAt: null, seconds: 0, connected: false, serverNow: now };
  const p = await getPerson(s.id, identity);
  if (!p) return { sessionId: s.id, sessionStartedAt: s.startedAt, seconds: 0, connected: false, serverNow: now };
  const { intervals, connected } = personIntervals(p, s, now);
  return {
    sessionId: s.id,
    sessionStartedAt: s.startedAt,
    seconds: Math.floor(totalMs(countedIntervals(intervals)) / 1000),
    connected,
    serverNow: now,
  };
}

/** For tests and reports: a person's merged intervals in a session. */
export function mergedFor(p: PersonRecord, s: PrayerSession, now: number): Interval[] {
  return mergeIntervals(personIntervals(p, s, now).intervals);
}
