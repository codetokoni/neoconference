// src/lib/muteAll.ts
//
// What "Mute all" (and "Mute everyone else") does to a room, apart from
// LiveKit's client so a smoke test can drive it (muteAll.smoke.ts).
//
// It used to mute one microphone at a time, waiting for each LiveKit call
// before the next, including microphones already muted and people who had
// just left (each a failed call, "participant does not exist"). The host's
// button said "Muting…" for as long as all of that took, longer the larger
// the meeting. Now only live microphones are muted, MUTE_CONCURRENCY at a
// time.

/** A participant as LiveKit's listParticipants gives it (the fields used). */
export interface RoomParticipant {
  identity?: string;
  metadata?: string;
  tracks?: Array<{
    sid: string;
    source?: number | string;
    type?: number | string;
    muted?: boolean;
  }>;
}

export interface MuteJob {
  identity: string;
  trackSid: string;
}

/** How many LiveKit mute calls are in flight at once. */
export const MUTE_CONCURRENCY = 12;

/**
 * The microphones to mute: everyone's but the caller's, the exempted
 * speaker's (Mute everyone else) and the hosts' and moderators' (FRS §5.1),
 * and only microphones that are not muted already. `skipped` counts the
 * people left alone.
 */
export function planMuteAll(
  list: RoomParticipant[],
  opts: { actorId: string; exceptBase: string },
): { jobs: MuteJob[]; skipped: number; alreadyMuted: number } {
  const actorId = opts.actorId.toLowerCase();
  const exceptBase = opts.exceptBase.toLowerCase();
  const jobs: MuteJob[] = [];
  let skipped = 0;
  let alreadyMuted = 0;

  for (const p of list) {
    const identity = p.identity || '';
    const base = identity.split('#')[0].toLowerCase();

    // Never mute the caller — defensive belt-and-suspenders with the role check.
    if (actorId && base === actorId) {
      skipped++;
      continue;
    }
    // §5.2: keep the exempted speaker unmuted.
    if (exceptBase && base === exceptBase) {
      skipped++;
      continue;
    }
    // Skip elevated roles per FRS §5.1. Metadata uses wire-format role
    // (owner/host collapse to "host", moderator to "cohost" via toLegacyRole).
    let role: string | undefined;
    try {
      const md = p.metadata ? JSON.parse(p.metadata) : {};
      role = typeof (md as { role?: unknown })?.role === 'string' ? (md as { role: string }).role : undefined;
    } catch {
      role = undefined;
    }
    if (role === 'host' || role === 'cohost') {
      skipped++;
      continue;
    }

    for (const t of p.tracks || []) {
      const src = typeof t.source === 'string' ? t.source.toUpperCase() : t.source;
      const typ = typeof t.type === 'string' ? t.type.toUpperCase() : t.type;
      // LiveKit sends source as enum int (2 = MICROPHONE) and type as int
      // (0 = AUDIO). Match by source first; fall back to type if unset.
      const isMic = src === 'MICROPHONE' || src === 2 || (src === undefined && (typ === 'AUDIO' || typ === 0));
      if (!isMic) continue;
      if (t.muted) {
        alreadyMuted++;
        continue;
      }
      jobs.push({ identity, trackSid: t.sid });
    }
  }
  return { jobs, skipped, alreadyMuted };
}

/**
 * Runs `fn` on every item, at most `limit` at once; never throws. Returns
 * how many succeeded and how many failed.
 */
export async function runLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
): Promise<{ ok: number; failed: number }> {
  let next = 0;
  let ok = 0;
  let failed = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
        ok++;
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return { ok, failed };
}
