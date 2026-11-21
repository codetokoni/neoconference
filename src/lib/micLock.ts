// src/lib/micLock.ts
//
// "Mute everyone" as a lock: while a meeting's microphone lock is on, every
// ordinary participant may publish their camera and screen but not their
// microphone. LiveKit enforces it (checked against livekit-server 1.9,
// 2026-11-21):
//   - taking MICROPHONE out of a participant's canPublishSources unpublishes
//     their live microphone at once, and leaves the camera and screen alone;
//   - while it is out, setMicrophoneEnabled, unmuting the old publication and
//     publishing a new microphone track are all refused ("insufficient
//     permissions");
//   - putting it back unmutes nobody: each person turns their own
//     microphone on again.
// Owners, hosts and moderators ("host" / "cohost" on the wire) keep their
// microphones. A token issued while the lock is on carries it (the room,
// a partner widget, the developer API), so latecomers and reconnects are
// locked too; a role change re-applies it to the person (events/[id]/roles).

import { TrackSource, type ParticipantPermission } from "livekit-server-sdk";
import type { NeoEvent } from "@/types/event";

/** What a locked participant may publish: everything but the microphone. */
export const MIC_LOCKED_SOURCES: TrackSource[] = [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];

/** The meeting's lock, as stored on the event while it is on. */
export interface MicLock {
  locked: true;
  /** Who turned it on (Clerk user id). */
  by: string;
  at: string;
}

/** Owner, host and moderator keep their microphones. */
export function keepsMicrophone(wireRole: unknown): boolean {
  return wireRole === "host" || wireRole === "cohost";
}

export function isMicLocked(ev: Pick<NeoEvent, "micLock"> | null | undefined): boolean {
  return ev?.micLock?.locked === true;
}

/**
 * The extra grant for a token issued to someone with `wireRole` in this
 * meeting: the locked sources while the lock is on and they are an ordinary
 * participant, nothing otherwise (a grant without canPublishSources may
 * publish anything).
 */
export function micLockGrant(
  ev: Pick<NeoEvent, "micLock"> | null | undefined,
  wireRole: unknown,
): { canPublishSources?: TrackSource[] } {
  return isMicLocked(ev) && !keepsMicrophone(wireRole) ? { canPublishSources: [...MIC_LOCKED_SOURCES] } : {};
}

/** A participant as listParticipants gives it (the fields used). */
export interface LockParticipant {
  identity?: string;
  metadata?: string;
  kind?: number | string;
  permission?: ParticipantPermission | Partial<ParticipantPermission>;
}

export function wireRoleOf(metadata: string | undefined): string | undefined {
  try {
    const md = metadata ? JSON.parse(metadata) : {};
    return typeof md?.role === "string" ? md.role : undefined;
  } catch {
    return undefined;
  }
}

/** Captions, translation voices and other agents speak for the room: never locked. */
function isAgent(p: LockParticipant): boolean {
  if (p.kind === 4 || p.kind === "AGENT") return true;
  const id = (p.identity || "").toLowerCase();
  return id.startsWith("agent-") || id.startsWith("neo-captions");
}

function hasLock(perm: LockParticipant["permission"]): boolean {
  const sources = (perm?.canPublishSources || []) as Array<number | string>;
  return sources.length > 0 && !sources.some((s) => s === TrackSource.MICROPHONE || s === "MICROPHONE");
}

/** The permission a participant should have: theirs, with the microphone in or out. */
export function withMicLock(perm: LockParticipant["permission"], locked: boolean): Partial<ParticipantPermission> {
  return {
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
    ...(perm || {}),
    canPublishSources: locked ? [...MIC_LOCKED_SOURCES] : [],
  };
}

export interface LockJob {
  identity: string;
  permission: Partial<ParticipantPermission>;
}

/**
 * Who needs a permission change for the room to match the lock: ordinary
 * participants locked (or unlocked), anyone who keeps their microphone
 * unlocked (a moderator promoted while locked), nobody already right and no
 * agent.
 */
export function planMicLock(list: LockParticipant[], locked: boolean): LockJob[] {
  const jobs: LockJob[] = [];
  for (const p of list) {
    if (!p.identity || isAgent(p)) continue;
    const want = locked && !keepsMicrophone(wireRoleOf(p.metadata));
    if (hasLock(p.permission) === want) continue;
    jobs.push({ identity: p.identity, permission: withMicLock(p.permission, want) });
  }
  return jobs;
}

/** Room metadata with the lock written in; other keys are kept. */
export function roomMetadataWithLock(current: string | undefined, locked: boolean): string {
  let md: Record<string, unknown> = {};
  try {
    const parsed = current ? JSON.parse(current) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) md = parsed;
  } catch {
    md = {};
  }
  return JSON.stringify({ ...md, micLock: locked });
}
