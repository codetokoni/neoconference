// src/lib/ringEngine.ts
//
// Ringing people into group meetings, and the reminders before them.
//
// Storage (Vercel KV, in-memory fallback as elsewhere)
//   neo:event:<eid>:calls   hash   userId -> { status, attempts, lastAttemptAt, ringId, kcSent }
//
// A ring round goes to everyone invited (the group as it is now, plus extras
// and anyone added) except people who have joined, answered or declined, who
// are in the room already, or who have been rung as often as the group allows
// (group.settings.maxAttempts). Someone still "ringing" from the last round
// did not answer: that round becomes a missed call before the next one.
// Someone in a different meeting is told quietly instead of being rung over.
// Rounds repeat every group.settings.retryIntervalMin minutes until nobody is
// left to ring or the meeting is over.
//
// KingsChat is the fallback, once per person per meeting: at the first ring
// for someone with no browser registered for alerts, or at the second ring
// for someone who has one and still has not come.
//
// Everything takes `now`, so tests run on a fake clock.

import { kv } from "@vercel/kv";
import { randomBytes } from "node:crypto";
import { eventStore } from "@/lib/eventStore";
import { getGroup, getMember } from "@/lib/groupStore";
import { inviteesOf } from "@/lib/groupMeetings";
import { getPresence } from "@/lib/presence";
import { sendPush, topicFor, type PushPayload } from "@/lib/pushStore";
import { addNotification } from "@/lib/notificationStore";
import { joinUrl, whenText } from "@/lib/groupNotify";
import { kcIdForClerkUser, sendKcMessage } from "@/lib/kingschat-send";
import {
  acquireTickLock,
  claimDue,
  releaseTickLock,
  scheduleJob,
  type Job,
} from "@/lib/scheduler";
import type { NeoEvent } from "@/types/event";

export type CallStatus = "ringing" | "answered" | "joined" | "declined" | "missed" | "busy";

export interface CallRecord {
  status: CallStatus;
  attempts: number;
  /** Epoch ms. */
  lastAttemptAt: number;
  ringId: string;
  /** KingsChat fallback already sent for this meeting. */
  kcSent: boolean;
}

/** How long a ring lasts on someone's screen. */
export const RING_MS = 45_000;
/** A ring job this late is no longer a call anyone would answer. */
export const STALE_RING_MS = 2 * 60_000;

/** People who need no more rings. */
const SETTLED: CallStatus[] = ["joined", "answered", "declined"];

/* -------------------------------------------------------------------------- */
/*  Storage                                                                    */
/* -------------------------------------------------------------------------- */

const callsKey = (eid: string) => `neo:event:${eid}:calls`;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const mem = new Map<string, Map<string, CallRecord>>();

function parseCall(raw: unknown): CallRecord | null {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const statuses: CallStatus[] = ["ringing", "answered", "joined", "declined", "missed", "busy"];
  if (!statuses.includes(r.status as CallStatus)) return null;
  return {
    status: r.status as CallStatus,
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    lastAttemptAt: typeof r.lastAttemptAt === "number" ? r.lastAttemptAt : 0,
    ringId: typeof r.ringId === "string" ? r.ringId : "",
    kcSent: r.kcSent === true,
  };
}

export async function getCalls(eid: string): Promise<Map<string, CallRecord>> {
  if (!isKvConfigured()) return new Map(mem.get(eid) ?? []);
  const raw = (await kv.hgetall(callsKey(eid))) as Record<string, unknown> | null;
  const out = new Map<string, CallRecord>();
  for (const [uid, v] of Object.entries(raw ?? {})) {
    const c = parseCall(v);
    if (c) out.set(uid, c);
  }
  return out;
}

export async function getCall(eid: string, uid: string): Promise<CallRecord | null> {
  if (!isKvConfigured()) return mem.get(eid)?.get(uid) ?? null;
  const raw = await kv.hget(callsKey(eid), uid);
  return raw == null ? null : parseCall(raw);
}

async function setCall(eid: string, uid: string, c: CallRecord): Promise<void> {
  if (!isKvConfigured()) {
    let b = mem.get(eid);
    if (!b) {
      b = new Map();
      mem.set(eid, b);
    }
    b.set(uid, c);
    return;
  }
  await kv.hset(callsKey(eid), { [uid]: JSON.stringify(c) });
}


const blank = (): CallRecord => ({ status: "missed", attempts: 0, lastAttemptAt: 0, ringId: "", kcSent: false });

/* -------------------------------------------------------------------------- */
/*  KingsChat (replaceable in tests)                                           */
/* -------------------------------------------------------------------------- */

export type KcOutcome = "sent" | "failed" | "unavailable";
export type KingsChatSender = (fromUserId: string, toUserId: string, text: string) => Promise<KcOutcome>;

const defaultKc: KingsChatSender = async (from, to, text) => {
  const kcId = await kcIdForClerkUser(to);
  if (!kcId) return "unavailable";
  const res = await sendKcMessage(from, kcId, text);
  if (res.ok) return "sent";
  return res.reason === "sender_not_linked" ? "unavailable" : "failed";
};
let kcSender: KingsChatSender = defaultKc;

/** Tests only: route KingsChat through `fake` (or back to the real one with null). */
export function __setKingsChatSender(fake: KingsChatSender | null): void {
  kcSender = fake ?? defaultKc;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Over: ended, cancelled or archived — no more rings or reminders. */
export function isOver(ev: NeoEvent): boolean {
  return Boolean(ev.groupMeeting?.cancelledAt) || ev.state === "ended" || ev.state === "replay" || ev.state === "archived";
}

/**
 * Who a meeting rings: everyone invited who has an account, except whoever
 * made it — the call comes from them, and they have had the reminders.
 */
async function ringable(ev: NeoEvent): Promise<string[]> {
  const creator = ev.groupMeeting?.createdBy;
  return (await inviteesOf(ev))
    .map((r) => r.userId)
    .filter((u): u is string => Boolean(u) && u !== creator);
}

async function meetingContext(ev: NeoEvent) {
  const group = ev.groupId ? await getGroup(ev.groupId) : null;
  if (!group || !ev.groupMeeting) return null;
  const creator = await getMember(group.id, ev.groupMeeting.createdBy);
  return {
    group,
    callerId: ev.groupMeeting.createdBy,
    callerName: creator?.name || ev.ownerName || "Your group",
  };
}

/* -------------------------------------------------------------------------- */
/*  Ringing                                                                    */
/* -------------------------------------------------------------------------- */

export interface RingRound {
  rung: string[];
  busy: string[];
  missed: string[];
  /** When the next round is queued for, or null when no one is left to ring. */
  nextAt: number | null;
}

/**
 * One ring round. `only` limits it to some people (Add participants rings
 * just the new ones); `except` leaves someone out (whoever started the
 * meeting is already walking in).
 */
export async function ringAttempt(
  eid: string,
  opts: { now?: number; round?: number; only?: string[]; except?: string } = {}
): Promise<RingRound> {
  const now = opts.now ?? Date.now();
  const round: RingRound = { rung: [], busy: [], missed: [], nextAt: null };
  const ev = await eventStore.byId(eid);
  if (!ev || isOver(ev)) return round;
  const ctx = await meetingContext(ev);
  if (!ctx) return round;
  const { maxAttempts } = ctx.group.settings;

  let invitees = await ringable(ev);
  if (opts.only) invitees = invitees.filter((u) => opts.only!.includes(u));
  if (opts.except) invitees = invitees.filter((u) => u !== opts.except);

  const calls = await getCalls(eid);
  const title = ev.name;
  const link = joinUrl(ev.slug);

  for (const uid of invitees) {
    const c: CallRecord = { ...(calls.get(uid) ?? blank()) };
    if (SETTLED.includes(c.status)) continue;

    const presence = await getPresence(uid, now);
    if (presence?.eventId === ev.id) {
      await setCall(eid, uid, { ...c, status: "joined" });
      continue;
    }
    if (c.attempts >= maxAttempts) continue;

    if (c.status === "ringing") {
      c.status = "missed";
      round.missed.push(uid);
      await addNotification(uid, {
        type: "missed",
        title: "You missed a meeting call",
        body: `${title} is in progress. Join now`,
        url: link,
        eventSlug: ev.slug,
      });
    }

    if (presence) {
      // In another meeting: say so quietly, do not ring over it.
      await setCall(eid, uid, { ...c, status: "busy", attempts: c.attempts + 1, lastAttemptAt: now });
      await addNotification(uid, {
        type: "missed",
        title: `${ctx.callerName} is calling you into ${title}`,
        body: "You're in another meeting. Join when you're free.",
        url: link,
        eventSlug: ev.slug,
      });
      round.busy.push(uid);
      continue;
    }

    const ringId = randomBytes(9).toString("base64url");
    const expiresAt = now + RING_MS;
    const payload: PushPayload = {
      type: "ring",
      title: `${ctx.group.name}: ${title}`,
      body: `${ctx.callerName} is calling`,
      url: link,
      eventSlug: ev.slug,
      groupId: ctx.group.id,
      ringId,
      expiresAt,
      caller: ctx.callerName,
      groupName: ctx.group.name,
      meetingTitle: title,
    };
    const pushed = await sendPush(uid, payload, { ttlSec: RING_MS / 1000, urgency: "high", topic: topicFor(ev.slug) });
    const hasDevices = pushed.configured && pushed.devices.length > 0;
    await addNotification(uid, {
      type: "ring",
      title: payload.title,
      body: payload.body,
      url: link,
      eventSlug: ev.slug,
      ringId,
      expiresAt,
      caller: ctx.callerName,
      groupName: ctx.group.name,
      meetingTitle: title,
    });

    const next: CallRecord = { ...c, status: "ringing", attempts: c.attempts + 1, lastAttemptAt: now, ringId };
    const escalate = !next.kcSent && ((next.attempts === 1 && !hasDevices) || (next.attempts >= 2 && hasDevices));
    if (escalate) {
      const outcome = await kcSender(
        ctx.callerId,
        uid,
        `${ctx.callerName} is calling you into “${title}” (${ctx.group.name}). Join now: ${siteOrigin()}${link}`
      ).catch(() => "failed" as const);
      if (outcome !== "unavailable") next.kcSent = true;
    }
    await setCall(eid, uid, next);
    round.rung.push(uid);
  }

  round.nextAt = await queueNextRound(ev, ctx.group.settings, now, (opts.round ?? 1) + 1);
  return round;
}

/** The site, for links in KingsChat messages (which leave the site). */
function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://www.neoconference.app").replace(/\/+$/, "");
}

/**
 * Queue the next round if anyone invited can still be rung. Returns when, or
 * null when everyone has joined, answered, declined or used their rings.
 */
async function queueNextRound(
  ev: NeoEvent,
  settings: { maxAttempts: number; retryIntervalMin: number },
  now: number,
  round: number
): Promise<number | null> {
  if (isOver(ev)) return null;
  const invitees = await ringable(ev);
  const calls = await getCalls(ev.id);
  const pending = invitees.some((uid) => {
    const c = calls.get(uid);
    if (!c) return false; // never rung: not part of any call yet
    return !SETTLED.includes(c.status) && c.attempts < settings.maxAttempts;
  });
  if (!pending) return null;
  const at = now + settings.retryIntervalMin * 60_000;
  await scheduleJob(ev.id, "ring", at, { attempt: round, now });
  return at;
}

/**
 * Ring now, without waiting for a tick: Start now, a private call, Add
 * participants, Ring again. Later rounds are queued as usual.
 */
export async function ringNow(
  eid: string,
  opts: { only?: string[]; except?: string; now?: number } = {}
): Promise<RingRound> {
  return ringAttempt(eid, { ...opts, round: 1 });
}

/** "Ring again": these people start over, as if never rung. */
export async function ringAgain(eid: string, userIds: string[], now: number = Date.now()): Promise<RingRound> {
  const calls = await getCalls(eid);
  for (const uid of userIds) {
    const c = calls.get(uid);
    if (c && c.status !== "joined") await setCall(eid, uid, { ...c, status: "missed", attempts: 0 });
  }
  return ringAttempt(eid, { only: userIds, now, round: 1 });
}

/* -------------------------------------------------------------------------- */
/*  Answers and joins                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The person answered or declined a ring. A decline ends their rings for this
 * meeting; an answer stops them until the room confirms the join.
 */
export async function respondToRing(
  eid: string,
  uid: string,
  action: "answer" | "decline",
  now: number = Date.now()
): Promise<CallRecord> {
  const c = (await getCall(eid, uid)) ?? blank();
  const next: CallRecord = {
    ...c,
    status: action === "answer" ? (c.status === "joined" ? "joined" : "answered") : "declined",
    lastAttemptAt: c.lastAttemptAt || now,
  };
  await setCall(eid, uid, next);
  return next;
}

/**
 * Someone's join was recorded (src/lib/attendance.ts). If they were being
 * called into this meeting, the calling stops. One read for anyone else.
 */
export async function markJoinedIfCalled(eid: string, uid: string): Promise<boolean> {
  const c = await getCall(eid, uid);
  if (!c || c.status === "joined") return false;
  await setCall(eid, uid, { ...c, status: "joined" });
  return true;
}


/* -------------------------------------------------------------------------- */
/*  Reminders                                                                  */
/* -------------------------------------------------------------------------- */

/** "Starts in 1 hour / in 30 minutes" to everyone invited, unless it already started. */
export async function sendReminder(eid: string, minutes: 60 | 30, now: number = Date.now()): Promise<number> {
  const ev = await eventStore.byId(eid);
  if (!ev || isOver(ev) || ev.state !== "scheduled" || !ev.groupMeeting) return 0;
  const ctx = await meetingContext(ev);
  if (!ctx) return 0;
  const recipients = (await inviteesOf(ev)).filter((r) => r.userId);
  const title = `${ev.name} starts in ${minutes === 60 ? "1 hour" : "30 minutes"}`;
  const body = `${ctx.group.name} · ${whenText(ev)}`;
  const start = Date.parse(ev.scheduledAt || "");
  const payload: PushPayload = {
    type: "reminder",
    title,
    body,
    url: `/${ev.slug}`,
    eventSlug: ev.slug,
    groupId: ctx.group.id,
    expiresAt: Number.isFinite(start) ? start + ev.groupMeeting.durationMin * 60_000 : now + 60 * 60_000,
  };
  for (const r of recipients) {
    await addNotification(r.userId!, { type: "reminder", title, body, url: payload.url, eventSlug: ev.slug });
    await sendPush(r.userId!, payload, { ttlSec: minutes * 60, urgency: "normal", topic: topicFor(ev.slug) }).catch(
      (err) => console.warn("[ring] reminder push failed", err)
    );
  }
  return recipients.length;
}

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

export interface DispatchResult {
  ran: number;
  skipped: number;
  errors: number;
  /** Another tick held the lock; this one did nothing. */
  locked?: boolean;
}

/** Run one job. "skipped" when it no longer applies. */
export async function runJob(job: Job, now: number = Date.now()): Promise<"ran" | "skipped"> {
  if (job.type === "remind60" || job.type === "remind30") {
    return (await sendReminder(job.eid, job.type === "remind60" ? 60 : 30, now)) > 0 ? "ran" : "skipped";
  }
  // A ring this late would reach no one in time: whoever is still ringing
  // missed it, and the next round is queued as normal.
  if (now - job.fireAt > STALE_RING_MS) {
    const ev = await eventStore.byId(job.eid);
    if (!ev || isOver(ev)) return "skipped";
    const ctx = await meetingContext(ev);
    if (!ctx) return "skipped";
    const calls = await getCalls(job.eid);
    for (const [uid, c] of calls) {
      if (c.status !== "ringing") continue;
      await setCall(job.eid, uid, { ...c, status: "missed" });
      await addNotification(uid, {
        type: "missed",
        title: "You missed a meeting call",
        body: `${ev.name} is in progress. Join now`,
        url: joinUrl(ev.slug),
        eventSlug: ev.slug,
      });
    }
    await scheduleJob(job.eid, "ring", now + ctx.group.settings.retryIntervalMin * 60_000, {
      attempt: (job.attempt ?? 1) + 1,
      now,
    });
    return "skipped";
  }
  await ringAttempt(job.eid, { now, round: job.attempt ?? 1 });
  return "ran";
}

/** One tick: take what is due and run it. Overlapping ticks back off. */
export async function runDispatch(now: number = Date.now()): Promise<DispatchResult> {
  if (!(await acquireTickLock(now))) return { ran: 0, skipped: 0, errors: 0, locked: true };
  const result: DispatchResult = { ran: 0, skipped: 0, errors: 0 };
  try {
    const jobs = await claimDue(now, 200);
    for (const job of jobs) {
      try {
        if ((await runJob(job, now)) === "ran") result.ran++;
        else result.skipped++;
      } catch (err) {
        result.errors++;
        console.error("[dispatch] job failed", job.id, err);
      }
    }
  } finally {
    await releaseTickLock();
  }
  return result;
}
