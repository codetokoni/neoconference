// src/lib/partners/moderation.ts
//
// Muting in a partner's zone meeting, from inside the embed. Only the
// zone's leaders and the organisation's administrators may (the lists in
// store.ts, set by the partner's server or an administrator here), checked
// again on every request so a leader removed mid-meeting loses it at once.
// Guests never may.
//
// Muting only: no one is ever unmuted from here (FRS §5.3, as
// /api/livekit/mute), and the meeting's hosts are never muted by a leader.
// Mute all also keeps every leader and moderator unmuted, as the room's own
// Mute all does (src/app/api/livekit/muteAll/route.ts).

import { eventStore } from "@/lib/eventStore";
import { PartnerError, leadsZone, type JoinGrant } from "@/lib/partners/store";
import { isHuman, livekit, participantIdentity } from "@/lib/partners/join";

type Track = { sid: string; source?: number | string; type?: number | string; muted?: boolean };
type Person = { identity: string; kind?: unknown; metadata?: string; tracks?: Track[] };

/** LiveKit sends the source as a number (2 = microphone); an older track may only say it is audio (0). */
function isMic(t: Track): boolean {
  const src = typeof t.source === "string" ? t.source.toUpperCase() : t.source;
  const typ = typeof t.type === "string" ? t.type.toUpperCase() : t.type;
  return src === "MICROPHONE" || src === 2 || (src === undefined && (typ === "AUDIO" || typ === 0));
}

function roleOf(p: Person): string | undefined {
  try {
    const md = p.metadata ? (JSON.parse(p.metadata) as { role?: unknown }) : {};
    return typeof md.role === "string" ? md.role : undefined;
  } catch {
    return undefined;
  }
}

/** Refuses anyone who does not lead this zone now. */
export async function assertModerator(grant: JoinGrant): Promise<void> {
  if (!(await leadsZone(grant))) {
    throw new PartnerError(403, "not_a_leader", "Only this zone's leaders can mute people.");
  }
}

async function roomOf(grant: JoinGrant): Promise<string> {
  const ev = await eventStore.byId(grant.eventId);
  if (!ev) throw new PartnerError(404, "meeting_not_found", "This meeting no longer exists.");
  return ev.livekitRoom || ev.slug;
}

/** Mutes the microphones a person has on. Returns how many it muted. */
async function muteMics(room: string, p: Person): Promise<number> {
  const { svc } = livekit();
  if (!svc) throw new PartnerError(500, "not_configured", "Meetings are not configured.");
  let n = 0;
  for (const t of p.tracks || []) {
    if (!isMic(t) || t.muted) continue;
    await svc.mutePublishedTrack(room, p.identity, t.sid, true);
    n++;
  }
  return n;
}

/** A leader mutes one person in the zone's meeting. */
export async function muteOne(grant: JoinGrant, target: unknown): Promise<{ muted: number }> {
  if (typeof target !== "string" || !target || target.length > 200) throw new PartnerError(400, "invalid_identity", "Say who to mute.");
  if (target === participantIdentity(grant)) throw new PartnerError(400, "cannot_mute_self", "Use your own microphone button.");
  await assertModerator(grant);
  const room = await roomOf(grant);
  const { svc } = livekit();
  let p: Person;
  try {
    p = (await svc!.getParticipant(room, target)) as unknown as Person;
  } catch {
    throw new PartnerError(404, "not_in_meeting", "That person is no longer in the meeting.");
  }
  if (!isHuman(p)) throw new PartnerError(404, "not_in_meeting", "That person is no longer in the meeting.");
  if (roleOf(p) === "host") throw new PartnerError(403, "cannot_mute_host", "The meeting's host can't be muted from here.");
  return { muted: await muteMics(room, p) };
}

/** A leader mutes everyone but themselves, the hosts and the other leaders and moderators. */
export async function muteAll(grant: JoinGrant): Promise<{ muted: number; skipped: number }> {
  await assertModerator(grant);
  const room = await roomOf(grant);
  const { svc } = livekit();
  let list: Person[];
  try {
    list = (await svc!.listParticipants(room)) as unknown as Person[];
  } catch {
    throw new PartnerError(503, "livekit_unavailable", "Could not reach the meeting. Try again.");
  }
  const self = participantIdentity(grant);
  let muted = 0;
  let skipped = 0;
  for (const p of list) {
    const role = roleOf(p);
    if (p.identity === self || !isHuman(p) || role === "host" || role === "cohost") {
      skipped++;
      continue;
    }
    try {
      muted += await muteMics(room, p);
    } catch (e) {
      console.warn("[partners] mute all: one person failed", p.identity, e);
    }
  }
  return { muted, skipped };
}
