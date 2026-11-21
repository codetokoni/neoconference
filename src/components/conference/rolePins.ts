// src/components/conference/rolePins.ts
//
// Who is pinned at the top of the meeting for everyone: the Owner, then
// Hosts, then Moderators. Kept apart from React and LiveKit so the browser
// tests run it as it is (tests/unit/role-pins.spec.ts).
//
// The roles are the server's: the token route writes `role` ('host',
// 'cohost', 'attendee', 'guest') and `owner: true` into each person's
// LiveKit metadata, and the roles route rewrites `role` when someone is
// promoted or demoted, which LiveKit passes to every screen at once. A
// late joiner or someone back from a reconnect reads the same metadata,
// so everyone sees the same row.

export type PinRole = 'owner' | 'host' | 'moderator';

const RANK: Record<PinRole, number> = { owner: 0, host: 1, moderator: 2 };

export const PIN_ROLE_LABEL: Record<PinRole, string> = {
  owner: 'Owner',
  host: 'Host',
  moderator: 'Moderator',
};

type Person = { identity: string; metadata?: string | null };

/**
 * Their role for the row, or null for everyone else. The owner is 'host' on
 * the wire; the token's `owner` flag says which host owns the meeting, and
 * the room page's ownerUserId (identity is '<userId>#<suffix>') says it for
 * a token issued before that flag existed.
 */
export function pinRoleOf(p: Person, ownerUserId?: string | null): PinRole | null {
  let md: { role?: unknown; owner?: unknown } | null = null;
  try {
    md = p.metadata ? JSON.parse(p.metadata) : null;
  } catch {
    md = null;
  }
  const role = md && typeof md === 'object' ? md.role : undefined;
  const ownerById = !!ownerUserId && (p.identity === ownerUserId || p.identity.startsWith(ownerUserId + '#'));
  if (role === 'host' && (md?.owner === true || ownerById)) return 'owner';
  if (role === 'host') return 'host';
  if (role === 'cohost') return 'moderator';
  return null;
}

/**
 * The pinned people, Owner → Hosts → Moderators. People who share a role
 * keep the order they are given in, so pass the list in a stable order
 * (keepOrder: first seen), and the row does not shuffle when someone
 * speaks, reconnects or joins.
 */
export function rolePins<T extends Person>(
  people: readonly T[],
  ownerUserId?: string | null,
): { person: T; role: PinRole }[] {
  const pins: { person: T; role: PinRole; at: number }[] = [];
  people.forEach((person, at) => {
    const role = pinRoleOf(person, ownerUserId);
    if (role) pins.push({ person, role, at });
  });
  pins.sort((a, b) => RANK[a.role] - RANK[b.role] || a.at - b.at);
  return pins.map(({ person, role }) => ({ person, role }));
}

/**
 * Whether the row is worth showing: only when the main area would still
 * show someone other than this viewer, or a screen share. With nobody else
 * left there (the host alone, or a host and you in a call of two) the row
 * would shrink the people who matter to a strip above your own face; the
 * ordinary layout shows everyone instead.
 */
export function showPinnedRow(input: {
  pinned: number;
  /** Who would be left in the main area, by identity, and whether it is this viewer. */
  rest: readonly { identity: string; isLocal: boolean }[];
  sharing: boolean;
}): boolean {
  if (input.pinned === 0) return false;
  return input.sharing || input.rest.some((p) => !p.isLocal);
}
