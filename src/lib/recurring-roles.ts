// src/lib/recurring-roles.ts
//
// Per-owner "recurring roles" list — people the operator has marked as
// their permanent host/moderator/cohost so every new event they create
// starts with those roles already applied. Solves the "I made Sarah a
// moderator last week, why do I have to promote her again in every
// new meeting?" complaint.
//
// Storage
//   neo:owner:<userId>:recurring   Redis hash
//     field  = target identifier — Clerk userId OR lowercased email
//     value  = { role, addedAt, addedBy }
//
// Applied at event-creation time: /api/events/create and
// /api/events/instant call applyRecurringRoles() right after
// eventStore.create() so the per-event Redis role hash is seeded before
// anyone joins. Existing events are not retro-applied on their own —
// the operator can re-promote manually if they add a person after the
// event was created.

import { kv } from '@vercel/kv';
import { assignMeetingRole } from '@/lib/meeting-roles';
import type { MeetingRole, Actor } from '@/lib/permissions';

const KEY_PREFIX = 'neo:owner:';
const KEY_SUFFIX = ':recurring';

export interface RecurringRoleEntry {
  role: MeetingRole;
  addedAt: number;
  addedBy: string | null;
}

export interface RecurringRoleListItem extends RecurringRoleEntry {
  /** The identifier the row is keyed on — Clerk userId, lowercased email,
   *  or a `kc:<handle>` KingsChat handle. */
  identifier: string;
  /** Convenience for the UI: true when the identifier looks like an email. */
  isEmail: boolean;
  /** Convenience for the UI: true when the identifier is a KingsChat handle. */
  isKcHandle: boolean;
}

function keyFor(ownerUserId: string): string {
  return KEY_PREFIX + ownerUserId + KEY_SUFFIX;
}

function isKvConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN,
  );
}

// In-process fallback for local dev without KV — same pattern as eventStore /
// meeting-roles. NOT durable across lambdas or deploys.
const mem = new Map<string, Map<string, RecurringRoleEntry>>();
function memBucket(userId: string): Map<string, RecurringRoleEntry> {
  let b = mem.get(userId);
  if (!b) {
    b = new Map();
    mem.set(userId, b);
  }
  return b;
}

function parseEntry(raw: unknown): RecurringRoleEntry | null {
  if (!raw) return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const r = (obj as { role?: unknown }).role;
  // Fold legacy display aliases into their canonical MeetingRole values
  // so rows written before the UI was corrected still render. 'speaker'
  // was never a real ladder rank — treat it as moderator (the closest
  // sensible interpretation) rather than dropping the row silently.
  let role: MeetingRole;
  if (r === 'host') role = 'host';
  else if (r === 'moderator' || r === 'cohost' || r === 'speaker') role = 'moderator';
  else return null;
  const at = (obj as { addedAt?: unknown }).addedAt;
  const by = (obj as { addedBy?: unknown }).addedBy;
  return {
    role,
    addedAt: typeof at === 'number' && Number.isFinite(at) ? at : 0,
    addedBy: typeof by === 'string' && by.length > 0 ? by : null,
  };
}

/** Recognised identifier shapes:
 *   `foo@bar.com`     -> lowercased email
 *   `@handle`         -> `kc:handle` (KingsChat handle)
 *   `kc:handle`       -> `kc:handle` (KingsChat handle, canonical form)
 *   `user_abc123`     -> Clerk userId (kept case-sensitive)
 *
 * `kc:` handles are stored under that exact key in the meeting-roles
 * hash — the rejoin lookup in /api/events/role and /api/livekit/token
 * pulls Clerk's stored `publicMetadata.kingschat.username` and probes
 * that same key, so a person marked via `@handle` gets their role the
 * moment they sign in with KingsChat, without needing to know their
 * Clerk userId in advance. */
function normalizeIdentifier(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (s.startsWith('@')) return 'kc:' + s.slice(1).toLowerCase();
  const lower = s.toLowerCase();
  if (lower.startsWith('kc:')) return 'kc:' + lower.slice(3);
  return s.includes('@') ? lower : s;
}

export async function listRecurringRoles(
  ownerUserId: string,
): Promise<RecurringRoleListItem[]> {
  if (!ownerUserId) return [];
  const rows: Array<{ identifier: string; entry: RecurringRoleEntry }> = [];
  if (!isKvConfigured()) {
    memBucket(ownerUserId).forEach((entry, identifier) =>
      rows.push({ identifier, entry }),
    );
  } else {
    try {
      const all = (await kv.hgetall(keyFor(ownerUserId))) as
        | Record<string, unknown>
        | null;
      for (const [identifier, raw] of Object.entries(all || {})) {
        const entry = parseEntry(raw);
        if (entry) rows.push({ identifier, entry });
      }
    } catch (err) {
      console.error('[recurring-roles] hgetall failed', err);
    }
  }
  return rows
    .map(({ identifier, entry }) => ({
      identifier,
      isEmail: identifier.includes('@'),
      isKcHandle: identifier.startsWith('kc:'),
      ...entry,
    }))
    .sort((a, b) => b.addedAt - a.addedAt);
}

export async function addRecurringRole(
  ownerUserId: string,
  identifierRaw: string,
  role: MeetingRole,
): Promise<void> {
  if (!ownerUserId) throw new Error('missing_owner');
  const identifier = normalizeIdentifier(identifierRaw);
  if (!identifier) throw new Error('missing_identifier');
  const entry: RecurringRoleEntry = {
    role,
    addedAt: Date.now(),
    addedBy: ownerUserId,
  };
  if (!isKvConfigured()) {
    memBucket(ownerUserId).set(identifier, entry);
    return;
  }
  try {
    await kv.hset(keyFor(ownerUserId), { [identifier]: entry });
  } catch (err) {
    console.error('[recurring-roles] hset failed', err);
    throw new Error('write_failed');
  }
}

export async function removeRecurringRole(
  ownerUserId: string,
  identifierRaw: string,
): Promise<void> {
  if (!ownerUserId) return;
  const identifier = normalizeIdentifier(identifierRaw);
  if (!identifier) return;
  if (!isKvConfigured()) {
    memBucket(ownerUserId).delete(identifier);
    return;
  }
  try {
    await kv.hdel(keyFor(ownerUserId), identifier);
  } catch (err) {
    console.error('[recurring-roles] hdel failed', err);
  }
}

/**
 * Seed a freshly created event with the owner's recurring roles. Called
 * right after eventStore.create(). Failures are logged but do not roll
 * back the event — the operator can re-promote manually if seeding fails.
 */
export async function applyRecurringRoles(
  eventId: string,
  ownerUserId: string,
): Promise<void> {
  if (!eventId || !ownerUserId) return;
  const list = await listRecurringRoles(ownerUserId).catch(() => []);
  if (list.length === 0) return;
  // The owner is the actor. assignMeetingRole runs the same rank guards
  // as any promotion, so we can't accidentally seed roles that would
  // otherwise be forbidden.
  const actor: Actor = {
    userId: ownerUserId,
    emails: [],
    role: 'owner',
  };
  for (const item of list) {
    // `kc:<handle>` looks like a userId to assignMeetingRole and gets
    // stored under its exact key — which is what we want, because
    // /api/events/role probes `kc:<current-user-kingschat-username>`
    // at rejoin time. Real emails go in the email bucket. Anything
    // else is a raw Clerk userId.
    const identity = item.isEmail
      ? { emails: [item.identifier] }
      : { userId: item.identifier };
    try {
      await assignMeetingRole(eventId, identity, item.role, actor);
    } catch (err) {
      console.warn(
        '[recurring-roles] seed failed for',
        item.identifier,
        item.role,
        err,
      );
    }
  }
}
