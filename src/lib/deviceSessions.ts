// src/lib/deviceSessions.ts
//
// One device at a time (owner, 2026-11-03). Signing in on a new device signs
// the account out everywhere else, unless the person turned on "Allow login
// on multiple devices" (Settings → Security → Device sessions).
//
// The unit is a Clerk session: the website and the app both sign in to
// Clerk, so one rule covers both, and revoking a Clerk session is what
// actually ends a device. Middleware sees every signed-in request; the first
// time it sees a session (checkDevice) that is the sign-in, and the older
// sessions are revoked. A revoked session is remembered here with why, so
//
//   * middleware refuses it at once — Clerk's session JWT stays valid for up
//     to a minute after revocation, and nothing it carries may get through;
//   * the device can be told why it was signed out (signedOutReason).
//
// Keys:
//   neo:device-sid:<sessionId>   -> SidRecord          (TTL 400 days)
//   neo:device-sids:<userId>     -> Set<sessionId>     (this account's, for erasure)
//   neo:device-policy:<userId>   -> { multi: true }    (absent = one device)
//
// EDGE-SAFE, like sessionStore: middleware imports it.

import { clerkClient } from '@clerk/nextjs/server';
import { kv } from '@/lib/kv';
import { dropForClerkSessions } from '@/lib/sessionStore';

const SID_PREFIX = 'neo:device-sid:';
const USER_SIDS_PREFIX = 'neo:device-sids:';
const POLICY_PREFIX = 'neo:device-policy:';
const TTL_SECONDS = 400 * 24 * 60 * 60;

/**
 * Sessions signed in before the rule existed are left alone, so nobody was
 * signed out by the deploy itself. The next sign-in anywhere ends them.
 */
export const ONE_DEVICE_SINCE = Date.parse('2026-11-03T16:30:00Z');

/** Why a device was signed out. */
export type SignOutReason = 'other_device' | 'elsewhere';

export const SIGNED_OUT_MESSAGE: Record<SignOutReason, string> = {
  other_device: 'You have been signed out because your account was signed in on another device.',
  elsewhere: 'This device was signed out from your account on another device.',
};

interface SidRecord {
  userId: string;
  state: 'active' | 'revoked';
  reason?: SignOutReason;
  /** "Chrome on Windows", "NeoLinguaMeet app on Android"… */
  label: string;
  ip: string | null;
  /** When this server first saw the session (its sign-in, or the rollout). */
  seenAt: number;
  revokedAt?: number;
}

export interface Device {
  id: string;
  label: string;
  ip: string | null;
  signedInAt: number;
  lastActiveAt: number;
  current: boolean;
}

export type DeviceCheck = { status: 'ok' } | { status: 'revoked'; reason: SignOutReason };

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

/** "Android app", "Chrome on Windows"… — enough to recognise a device, not a fingerprint. */
export function deviceLabel(ua: string | null | undefined): string {
  const s = ua || '';
  const os = /Android/i.test(s)
    ? 'Android'
    : /iPhone|iPad|iOS/i.test(s)
      ? 'iPhone'
      : /Windows/i.test(s)
        ? 'Windows'
        : /Mac OS|Macintosh/i.test(s)
          ? 'Mac'
          : /Linux/i.test(s)
            ? 'Linux'
            : null;
  if (/NeoConference|NeoLinguaMeet|Dart\//i.test(s)) return os ? `NeoLinguaMeet app on ${os}` : 'NeoLinguaMeet app';
  const browser = /Edg\//.test(s)
    ? 'Edge'
    : /OPR\/|Opera/.test(s)
      ? 'Opera'
      : /Firefox\//.test(s)
        ? 'Firefox'
        : /Chrome\//.test(s)
          ? 'Chrome'
          : /Safari\//.test(s)
            ? 'Safari'
            : 'Browser';
  return os ? `${browser} on ${os}` : browser;
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const memSids = new Map<string, SidRecord>();
const memPolicy = new Map<string, boolean>();

async function readSid(sessionId: string): Promise<SidRecord | null> {
  if (!isKvConfigured()) return memSids.get(sessionId) ?? null;
  return kv.get<SidRecord>(SID_PREFIX + sessionId);
}

/** Writes a record; with `onlyIfNew`, false when one was already there. */
async function writeSid(sessionId: string, record: SidRecord, onlyIfNew = false): Promise<boolean> {
  if (!isKvConfigured()) {
    if (onlyIfNew && memSids.has(sessionId)) return false;
    memSids.set(sessionId, record);
    return true;
  }
  const set = await kv.set(SID_PREFIX + sessionId, record, onlyIfNew ? { ex: TTL_SECONDS, nx: true } : { ex: TTL_SECONDS });
  if (onlyIfNew && set === null) return false;
  await kv.sadd(USER_SIDS_PREFIX + record.userId, sessionId);
  await kv.expire(USER_SIDS_PREFIX + record.userId, TTL_SECONDS);
  return true;
}

export async function allowsMultipleDevices(userId: string): Promise<boolean> {
  if (!isKvConfigured()) return memPolicy.get(userId) ?? false;
  const p = await kv.get<{ multi?: boolean }>(POLICY_PREFIX + userId);
  return p?.multi === true;
}

/* ------------------------------------------------------------------ */
/* Clerk                                                               */
/* ------------------------------------------------------------------ */

interface ClerkSessionLite {
  id: string;
  userId: string;
  createdAt: number;
  lastActiveAt: number;
  /** Set when an administrator is acting as the user (impersonation). */
  actor: unknown;
}

async function activeClerkSessions(userId: string): Promise<ClerkSessionLite[]> {
  const cc = await clerkClient();
  const list = await cc.sessions.getSessionList({ userId, status: 'active', limit: 100 });
  return list.data.map((s) => ({
    id: s.id,
    userId: s.userId,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
    actor: s.actor ?? null,
  }));
}

/**
 * Marks each session revoked (first, so the device is refused and told why
 * even if Clerk is slow), then revokes it at Clerk and drops the website's
 * device cookie made from it. Failures at Clerk are logged: the mark alone
 * already keeps the device out.
 */
async function revoke(userId: string, sessionIds: string[], reason: SignOutReason): Promise<void> {
  if (sessionIds.length === 0) return;
  const now = Date.now();
  await Promise.all(
    sessionIds.map(async (id) => {
      const before = await readSid(id).catch(() => null);
      await writeSid(id, {
        userId,
        label: before?.label ?? 'Unknown device',
        ip: before?.ip ?? null,
        seenAt: before?.seenAt ?? now,
        state: 'revoked',
        reason,
        revokedAt: now,
      });
      forget(id);
    }),
  );
  const cc = await clerkClient();
  const results = await Promise.allSettled(sessionIds.map((id) => cc.sessions.revokeSession(id)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed) console.error('[neo:deviceSessions] Clerk revoke failed for', failed, 'session(s)', { userId });
  await dropForClerkSessions(userId, sessionIds);
}

/* ------------------------------------------------------------------ */
/* The check middleware runs                                           */
/* ------------------------------------------------------------------ */

/** Sessions this instance saw as active lately: no KV read for each of their requests. */
const recentlyActive = new Map<string, number>();
const ACTIVE_MEMO_MS = 10_000;

function forget(sessionId: string) {
  recentlyActive.delete(sessionId);
}

function remember(sessionId: string) {
  if (recentlyActive.size > 5000) recentlyActive.clear();
  recentlyActive.set(sessionId, Date.now() + ACTIVE_MEMO_MS);
}

/**
 * Called by middleware for every request that carries a Clerk session.
 * 'revoked' means refuse it. Anything that goes wrong here answers 'ok':
 * Clerk still authenticates the request, and a KV or Clerk blip must not
 * sign people out (the same rule as sessionStore's 'error').
 */
export async function checkDevice(
  userId: string,
  sessionId: string,
  request: { userAgent: string | null; ip: string | null },
): Promise<DeviceCheck> {
  const memo = recentlyActive.get(sessionId);
  if (memo && memo > Date.now()) return { status: 'ok' };
  try {
    const record = await readSid(sessionId);
    if (record?.state === 'revoked') return { status: 'revoked', reason: record.reason ?? 'elsewhere' };
    if (record) {
      remember(sessionId);
      return { status: 'ok' };
    }
    return await claim(userId, sessionId, request);
  } catch (error) {
    console.error('[neo:deviceSessions] check failed; letting the request through', error);
    return { status: 'ok' };
  }
}

/**
 * The first request of a session: record it and, unless this account allows
 * several devices, sign out the sessions signed in before it. Only older
 * ones — two devices signing in at the same moment must not end each other.
 */
async function claim(
  userId: string,
  sessionId: string,
  request: { userAgent: string | null; ip: string | null },
): Promise<DeviceCheck> {
  const won = await writeSid(
    sessionId,
    { userId, state: 'active', label: deviceLabel(request.userAgent), ip: request.ip, seenAt: Date.now() },
    true,
  );
  if (!won) {
    // Another request of this session got here first.
    const record = await readSid(sessionId);
    if (record?.state === 'revoked') return { status: 'revoked', reason: record.reason ?? 'elsewhere' };
    remember(sessionId);
    return { status: 'ok' };
  }
  remember(sessionId);

  let sessions: ClerkSessionLite[];
  try {
    sessions = await activeClerkSessions(userId);
  } catch (error) {
    // Unclaimed again, so a later request of this session tries again
    // rather than the sign-in never signing the others out.
    forget(sessionId);
    if (!isKvConfigured()) memSids.delete(sessionId);
    else await kv.del(SID_PREFIX + sessionId).catch(() => undefined);
    throw error;
  }
  const self = sessions.find((s) => s.id === sessionId);
  // Not active at Clerk (ending already), signed in before the rule, or an
  // administrator acting as the user: nobody else is signed out.
  if (!self || self.createdAt < ONE_DEVICE_SINCE || self.actor) return { status: 'ok' };
  if (await allowsMultipleDevices(userId)) return { status: 'ok' };

  const older = sessions.filter((s) => s.id !== sessionId && !s.actor && s.createdAt <= self.createdAt).map((s) => s.id);
  if (older.length) {
    console.info('[neo:deviceSessions] new sign-in; signing out', older.length, 'other device(s)', { userId });
    await revoke(userId, older, 'other_device');
  }
  return { status: 'ok' };
}

/* ------------------------------------------------------------------ */
/* Settings → Security → Device sessions                               */
/* ------------------------------------------------------------------ */

/** The account's signed-in devices, newest activity first. */
export async function listDevices(userId: string, currentSessionId: string | null): Promise<Device[]> {
  const sessions = await activeClerkSessions(userId);
  const devices = await Promise.all(
    sessions
      .filter((s) => !s.actor)
      .map(async (s) => {
        const record = await readSid(s.id).catch(() => null);
        if (record?.state === 'revoked') return null;
        return {
          id: s.id,
          label: record?.label ?? 'Unknown device',
          ip: record?.ip ?? null,
          signedInAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          current: s.id === currentSessionId,
        } satisfies Device;
      }),
  );
  return devices
    .filter((d): d is Device => d !== null)
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt - a.lastActiveAt);
}

/** Signs out one of the account's own devices. False when it is not one of them. */
export async function signOutDevice(userId: string, sessionId: string): Promise<boolean> {
  const sessions = await activeClerkSessions(userId);
  if (!sessions.some((s) => s.id === sessionId)) return false;
  await revoke(userId, [sessionId], 'elsewhere');
  return true;
}

/** Signs out every device but this one; how many. */
export async function signOutOtherDevices(userId: string, currentSessionId: string): Promise<number> {
  const others = (await activeClerkSessions(userId)).filter((s) => s.id !== currentSessionId && !s.actor).map((s) => s.id);
  await revoke(userId, others, 'elsewhere');
  return others.length;
}

/**
 * "Allow login on multiple devices". Turning it off keeps this device and
 * signs out the rest, so the account is back to one device straight away.
 */
export async function setMultipleDevices(userId: string, on: boolean, currentSessionId: string): Promise<number> {
  if (!isKvConfigured()) {
    if (on) memPolicy.set(userId, true);
    else memPolicy.delete(userId);
  } else if (on) {
    await kv.set(POLICY_PREFIX + userId, { multi: true });
  } else {
    await kv.del(POLICY_PREFIX + userId);
  }
  return on ? 0 : signOutOtherDevices(userId, currentSessionId);
}

/** Why a session was signed out, for the device that held it; null if it was not. */
export async function signedOutReason(sessionId: string): Promise<SignOutReason | null> {
  if (!/^sess_[A-Za-z0-9]{10,64}$/.test(sessionId)) return null;
  const record = await readSid(sessionId).catch(() => null);
  return record?.state === 'revoked' ? (record.reason ?? 'elsewhere') : null;
}

/** Everything kept for this account (data erasure). */
export async function forgetDevices(userId: string, dry = false): Promise<number> {
  if (!isKvConfigured()) {
    let n = memPolicy.delete(userId) ? 1 : 0;
    for (const [id, r] of memSids) if (r.userId === userId && (n++, !dry)) memSids.delete(id);
    return n;
  }
  const sids = ((await kv.smembers(USER_SIDS_PREFIX + userId)) ?? []) as string[];
  const policy = (await kv.get(POLICY_PREFIX + userId)) ? 1 : 0;
  if (!dry) {
    for (const id of sids) await kv.del(SID_PREFIX + id);
    await kv.del(USER_SIDS_PREFIX + userId, POLICY_PREFIX + userId);
  }
  return sids.length + policy;
}
