// src/lib/sessionStore.ts
//
// KV-backed persistent device sessions. Users sign in once (Clerk or KingsChat)
// and stay signed in on every device until they explicitly sign out.
//
// Keys, following the neo: convention used by the other stores:
//   neo:session:<tokenHash>              -> SessionRecord   (TTL = sliding window)
//   neo:sessions:<userId>                -> Set<tokenHash>  (logout-everywhere + listing)
//   neo:session-device:<userId>:<fp>     -> tokenHash       (one session per device)
//
// EDGE-SAFE ON PURPOSE. This module uses only Web Crypto and @vercel/kv's HTTP
// client, so the exact same code runs in Edge middleware and in Node route
// handlers. Do not add `node:crypto` or any Node-only import here.
//
// Falls back to an in-memory Map per-process when Vercel KV is not configured,
// matching inviteStore/chatStore behaviour for local development.

import { kv } from '@vercel/kv';

const SESSION_PREFIX = 'neo:session:';
const INDEX_PREFIX = 'neo:sessions:';
const DEVICE_PREFIX = 'neo:session-device:';

export const SESSION_COOKIE = 'neoconf-session';

/** Sliding window, refreshed on activity. */
export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
/** Hard ceiling regardless of activity. */
const ABSOLUTE_MAX_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
/** Don't rewrite the record on every single request. */
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;

export interface SessionRecord {
  userId: string;
  fingerprint: string;
  userAgent: string | null;
  ip: string | null;
  ipLastSeen: string | null;
  createdAt: number;
  lastActivityAt: number;
}

export interface ActiveSession {
  id: string; // truncated hash — safe to show, not usable as a token
  userAgent: string | null;
  ip: string | null;
  createdAt: number;
  lastActivityAt: number;
  current: boolean;
}

/**
 * 'valid'   — session exists and matches the device.
 * 'invalid' — no such session, revoked, expired, or wrong device. Sign the user out.
 * 'error'   — KV was unreachable. Callers MUST fail open: Clerk is still the
 *             primary auth, and a KV blip must not sign the whole app out.
 */
export type ValidationResult =
  | { status: 'valid'; userId: string }
  | { status: 'invalid' }
  | { status: 'error' };

/* ------------------------------------------------------------------ */
/* KV configuration + in-memory dev fallback                           */
/* ------------------------------------------------------------------ */

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const memSessions = new Map<string, SessionRecord>();
const memIndex = new Map<string, Set<string>>();
const memDevice = new Map<string, string>();

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[neo:sessionStore] Vercel KV is not configured - sessions are kept in-memory only.',
  );
}

/* ------------------------------------------------------------------ */
/* Web Crypto helpers (Edge + Node)                                    */
/* ------------------------------------------------------------------ */

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

/**
 * A weak binding, NOT authentication. User-Agent and Accept-Language are
 * attacker-controlled, so this only raises the cost of replaying a stolen
 * cookie from a different client. The httpOnly + Secure + SameSite cookie and
 * the ability to revoke are the real controls.
 */
export async function generateDeviceFingerprint(
  userAgent: string,
  acceptLanguage: string,
): Promise<string> {
  return sha256Hex(`${(userAgent || '').trim()}|${(acceptLanguage || '').trim()}`);
}

async function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/** Length-safe, non-short-circuiting comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

/**
 * Issues a session for (userId, device) and returns the RAW token. Store it
 * only in the httpOnly cookie — never in a response body, never in a log.
 * Replaces any prior session for the same device so repeated sign-ins on one
 * browser don't accumulate entries.
 */
export async function createSession(
  userId: string,
  opts: { ip: string | null; fingerprint: string; userAgent: string | null },
): Promise<string> {
  if (!userId) throw new Error('createSession: userId is required');

  const token = newToken();
  const tokenHash = await hashToken(token);
  const now = Date.now();

  const record: SessionRecord = {
    userId,
    fingerprint: opts.fingerprint,
    userAgent: opts.userAgent,
    ip: opts.ip,
    ipLastSeen: opts.ip,
    createdAt: now,
    lastActivityAt: now,
  };

  const deviceKey = `${DEVICE_PREFIX}${userId}:${opts.fingerprint}`;

  if (!isKvConfigured()) {
    warnOnce();
    const previous = memDevice.get(deviceKey);
    if (previous) {
      memSessions.delete(previous);
      memIndex.get(userId)?.delete(previous);
    }
    memSessions.set(tokenHash, record);
    if (!memIndex.has(userId)) memIndex.set(userId, new Set());
    memIndex.get(userId)!.add(tokenHash);
    memDevice.set(deviceKey, tokenHash);
    return token;
  }

  try {
    // Drop the previous session for this same device.
    const previous = await kv.get<string>(deviceKey);
    if (previous) {
      await kv.del(`${SESSION_PREFIX}${previous}`);
      await kv.srem(`${INDEX_PREFIX}${userId}`, previous);
    }

    await kv.set(`${SESSION_PREFIX}${tokenHash}`, record, { ex: SESSION_TTL_SECONDS });
    await kv.sadd(`${INDEX_PREFIX}${userId}`, tokenHash);
    await kv.expire(`${INDEX_PREFIX}${userId}`, SESSION_TTL_SECONDS);
    await kv.set(deviceKey, tokenHash, { ex: SESSION_TTL_SECONDS });

    return token;
  } catch (error) {
    console.error('[neo:sessionStore] createSession failed', { userId, error });
    throw new Error('Failed to create session');
  }
}

/* ------------------------------------------------------------------ */
/* Validate                                                            */
/* ------------------------------------------------------------------ */

export async function validateSession(
  token: string,
  ip: string | null,
  fingerprint: string,
): Promise<ValidationResult> {
  if (!token || !fingerprint) return { status: 'invalid' };

  let tokenHash: string;
  try {
    tokenHash = await hashToken(token);
  } catch (error) {
    console.error('[neo:sessionStore] hashToken failed', error);
    return { status: 'error' };
  }

  const key = `${SESSION_PREFIX}${tokenHash}`;

  let record: SessionRecord | null = null;
  if (!isKvConfigured()) {
    warnOnce();
    record = memSessions.get(tokenHash) ?? null;
  } else {
    try {
      record = await kv.get<SessionRecord>(key);
    } catch (error) {
      // KV unreachable — fail OPEN. Clerk still gates the route.
      console.error('[neo:sessionStore] validateSession KV error', error);
      return { status: 'error' };
    }
  }

  if (!record) return { status: 'invalid' };

  // Hard ceiling, independent of the sliding TTL.
  if (Date.now() - record.createdAt > ABSOLUTE_MAX_MS) {
    await destroy(tokenHash, record.userId, record.fingerprint);
    return { status: 'invalid' };
  }

  if (!safeEqual(record.fingerprint, fingerprint)) {
    console.warn('[neo:sessionStore] device fingerprint mismatch; revoking', {
      userId: record.userId,
    });
    await destroy(tokenHash, record.userId, record.fingerprint);
    return { status: 'invalid' };
  }

  // Sliding refresh, throttled so we don't write on every request.
  const now = Date.now();
  if (now - record.lastActivityAt > TOUCH_THROTTLE_MS) {
    const updated: SessionRecord = { ...record, lastActivityAt: now, ipLastSeen: ip };
    if (!isKvConfigured()) {
      memSessions.set(tokenHash, updated);
    } else {
      try {
        await kv.set(key, updated, { ex: SESSION_TTL_SECONDS });
        await kv.expire(`${INDEX_PREFIX}${record.userId}`, SESSION_TTL_SECONDS);
        await kv.expire(
          `${DEVICE_PREFIX}${record.userId}:${record.fingerprint}`,
          SESSION_TTL_SECONDS,
        );
      } catch (error) {
        // Non-fatal: the session is still valid, we just didn't extend it.
        console.error('[neo:sessionStore] touch failed', error);
      }
    }
  }

  return { status: 'valid', userId: record.userId };
}

/* ------------------------------------------------------------------ */
/* Revoke                                                              */
/* ------------------------------------------------------------------ */

async function destroy(tokenHash: string, userId: string, fingerprint?: string): Promise<void> {
  if (!isKvConfigured()) {
    memSessions.delete(tokenHash);
    memIndex.get(userId)?.delete(tokenHash);
    if (fingerprint) memDevice.delete(`${DEVICE_PREFIX}${userId}:${fingerprint}`);
    return;
  }
  try {
    await kv.del(`${SESSION_PREFIX}${tokenHash}`);
    await kv.srem(`${INDEX_PREFIX}${userId}`, tokenHash);
    if (fingerprint) await kv.del(`${DEVICE_PREFIX}${userId}:${fingerprint}`);
  } catch (error) {
    console.error('[neo:sessionStore] destroy failed', { userId, error });
  }
}

export async function logout(
  userId: string,
  token: string | null,
  scope: 'device' | 'all' = 'device',
): Promise<void> {
  if (!userId) throw new Error('logout: userId is required');

  if (scope === 'all') {
    const hashes = await listHashes(userId);
    await Promise.all(
      hashes.map(async (hash) => {
        const record = await readRecord(hash);
        await destroy(hash, userId, record?.fingerprint);
      }),
    );
    if (!isKvConfigured()) {
      memIndex.delete(userId);
    } else {
      try {
        await kv.del(`${INDEX_PREFIX}${userId}`);
      } catch (error) {
        console.error('[neo:sessionStore] logout(all) index delete failed', { userId, error });
      }
    }
    return;
  }

  if (!token) return;

  const tokenHash = await hashToken(token);
  const record = await readRecord(tokenHash);
  // Ownership check: never let one user revoke another user's session.
  if (!record || record.userId !== userId) return;
  await destroy(tokenHash, userId, record.fingerprint);
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

async function listHashes(userId: string): Promise<string[]> {
  if (!isKvConfigured()) return Array.from(memIndex.get(userId) ?? []);
  try {
    return (await kv.smembers(`${INDEX_PREFIX}${userId}`)) ?? [];
  } catch (error) {
    console.error('[neo:sessionStore] listHashes failed', { userId, error });
    return [];
  }
}

async function readRecord(tokenHash: string): Promise<SessionRecord | null> {
  if (!isKvConfigured()) return memSessions.get(tokenHash) ?? null;
  try {
    return await kv.get<SessionRecord>(`${SESSION_PREFIX}${tokenHash}`);
  } catch (error) {
    console.error('[neo:sessionStore] readRecord failed', error);
    return null;
  }
}

export async function getActiveSessions(
  userId: string,
  currentToken?: string | null,
): Promise<ActiveSession[]> {
  if (!userId) return [];

  const currentHash = currentToken ? await hashToken(currentToken) : null;
  const hashes = await listHashes(userId);

  const records = await Promise.all(
    hashes.map(async (hash) => {
      const record = await readRecord(hash);
      if (!record) {
        // Expired out from under the index — tidy up.
        if (isKvConfigured()) {
          try {
            await kv.srem(`${INDEX_PREFIX}${userId}`, hash);
          } catch {}
        }
        return null;
      }
      return {
        // Never expose the full hash or the fingerprint: both make a stolen
        // cookie easier to replay.
        id: hash.slice(0, 12),
        userAgent: record.userAgent,
        ip: record.ipLastSeen ?? record.ip,
        createdAt: record.createdAt,
        lastActivityAt: record.lastActivityAt,
        current: currentHash === hash,
      } satisfies ActiveSession;
    }),
  );

  return records
    .filter((r): r is ActiveSession => r !== null)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/* ------------------------------------------------------------------ */
/* Request helpers                                                     */
/* ------------------------------------------------------------------ */

type HeaderLike = { get(name: string): string | null };

export function getClientIp(headers: HeaderLike): string | null {
  const candidates = [
    headers.get('cf-connecting-ip'),
    headers.get('x-real-ip'),
    headers.get('x-vercel-forwarded-for'),
    headers.get('x-forwarded-for')?.split(',')[0],
  ];
  for (const value of candidates) {
    const ip = value?.trim();
    if (ip && ip !== 'unknown') return ip;
  }
  return null;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}
