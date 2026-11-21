// src/lib/micLock.ts
//
// "Lock" (the toolbar) / "Lock participant microphones" (the People panel):
// an Owner, Host or Moderator stops everyone else in a meeting from sending
// anything — microphone, camera and screen sharing — and may let one person
// (or, by unlocking, everyone) use them again. Chat, reactions and a raised
// hand go on (they are data, a separate permission).
//
// Enforced by the media server, not by hiding a button: each locked
// participant's LiveKit permission has canPublish false. LiveKit then takes
// down every track they publish and refuses to publish one again. Checked
// against a real LiveKit server (2026-11-21, then for the microphone only):
// a revoked track disappeared at once, publishing failed with "insufficient
// permissions", and allowing it again switched nothing on.
// (Until 2026-11-21 the lock took only the microphone, leaving the camera
// and screen: LOCKED_SOURCES. A permission still in that shape counts as
// locked and is brought up to the full lock.)
//
// The state lives in KV (neo:miclock:<eventId>) and is applied:
//   - to everyone in the room when a moderator locks or unlocks, or to one
//     person when they are allowed or locked again (/api/livekit/mic-lock);
//   - in the join token (/api/livekit/token), so a late joiner starts locked;
//   - when LiveKit says someone joined or published a microphone (webhook),
//     which covers a reconnect that reuses an older token;
//   - when someone's role changes (/api/events/[id]/roles): a Moderator is
//     never locked.
// Clients learn of it from LiveKit's own permission update; moderators'
// screens also hear a "mic_lock" data message with the new state.
//
// Owners and Hosts are "host" on the wire and Moderators "cohost"; neither is
// ever locked. Service participants (translation and caption agents,
// recorders) are left alone: the translation agents publish audio.

import type { VideoGrant } from "livekit-server-sdk";
import { kv } from "@/lib/kv";
import { SERVICE_IDENTITY } from "@/lib/groupAttendees";

/** LiveKit's TrackSource numbers (livekit_models.proto). */
export const SOURCE = { CAMERA: 1, MICROPHONE: 2, SCREEN_SHARE: 3, SCREEN_SHARE_AUDIO: 4 } as const;
/** What the earlier, microphone-only lock let a locked participant publish. */
export const LOCKED_SOURCES: number[] = [SOURCE.CAMERA, SOURCE.SCREEN_SHARE, SOURCE.SCREEN_SHARE_AUDIO];
/** The data message topic moderators' screens listen on. */
export const MIC_LOCK_TOPIC = "mic_lock";

export interface MicLockState {
  locked: boolean;
  /** Base user ids (no "#tab" suffix) allowed to unmute while locked. */
  allowed: string[];
  /** Who changed it last, and when (epoch ms). */
  by?: string;
  at?: number;
}

export const UNLOCKED: MicLockState = { locked: false, allowed: [] };

/** The account id in a LiveKit identity ("user_x#tab" → "user_x"). */
export const baseIdentity = (identity: string): string => identity.split("#")[0];

/** Owners and Hosts are "host" on the wire, Moderators "cohost": never locked. */
export function isElevatedWireRole(role: string | null | undefined): boolean {
  return role === "host" || role === "cohost";
}

/**
 * What this person may send under this state:
 *   "open" — anything (not locked, or an Owner, Host or Moderator);
 *   "mic"  — only their microphone: allowed to talk while the meeting is
 *            locked, camera and screen still locked (owner's decision,
 *            2026-11-21);
 *   "none" — nothing: locked.
 */
export type Access = "open" | "mic" | "none";

export function accessFor(state: MicLockState, who: { role?: string | null; userId: string }): Access {
  if (!state.locked || isElevatedWireRole(who.role)) return "open";
  return state.allowed.includes(baseIdentity(who.userId)) ? "mic" : "none";
}

/** Whether this person may use their microphone under this state. */
export function micAllowedFor(state: MicLockState, who: { role?: string | null; userId: string }): boolean {
  return accessFor(state, who) !== "none";
}

/** What an allowed person may publish while the meeting is locked. */
export const MIC_ONLY: number[] = [SOURCE.MICROPHONE];

/**
 * A LiveKit permission giving this access, everything else kept (subscribing
 * and data, so chat and reactions go on). "none": nothing may be published.
 * "mic": only the microphone. "open": publishing as it was before the lock
 * (a list a lock made, this one's or the earlier microphone-only one's, is
 * cleared; a list we did not make keeps its sources).
 */
export function withAccess<P extends { canPublishSources?: number[]; canPublish?: boolean }>(perm: P, access: Access): P {
  if (access === "none") return { ...perm, canPublish: false, canPublishSources: [] };
  if (access === "mic") return { ...perm, canPublish: true, canPublishSources: [...MIC_ONLY] };
  const current = (perm.canPublishSources ?? []).map(Number);
  const madeByALock = current.length === 0 || sameSources(current, LOCKED_SOURCES) || sameSources(current, MIC_ONLY);
  const next = madeByALock ? [] : Array.from(new Set([...current, SOURCE.MICROPHONE]));
  return { ...perm, canPublish: true, canPublishSources: next };
}

function sameSources(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((s) => b.includes(s));
}

/** Whether a LiveKit permission lets the microphone be published (false under either lock). */
export function permitsMicrophone(perm: { canPublish?: boolean; canPublishSources?: number[] } | undefined): boolean {
  if (!perm) return true;
  if (perm.canPublish === false) return false;
  const list = (perm.canPublishSources ?? []).map(Number);
  return list.length === 0 || list.includes(SOURCE.MICROPHONE);
}

/**
 * Whether a participant's permission already gives this access: "none" —
 * nothing may be published (the earlier microphone-only lock is not
 * enough); "mic" — exactly the microphone; "open" — the microphone and not
 * a list a lock made.
 */
export function permissionIsAsWanted(perm: { canPublish?: boolean; canPublishSources?: number[] } | undefined, access: Access): boolean {
  if (access === "none") return perm?.canPublish === false;
  if (perm?.canPublish === false) return false;
  const list = (perm?.canPublishSources ?? []).map(Number);
  if (access === "mic") return sameSources(list, MIC_ONLY);
  return list.length === 0 || (list.includes(SOURCE.MICROPHONE) && !sameSources(list, MIC_ONLY));
}

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

const key = (eventId: string) => `neo:miclock:${eventId}`;
/** Kept a month after the last change; a meeting that long is unlocked by then in practice. */
const KEEP_S = 30 * 24 * 60 * 60;

export async function getMicLock(eventId: string): Promise<MicLockState> {
  try {
    const v = await kv.get<MicLockState | string>(key(eventId));
    if (!v) return UNLOCKED;
    const s = typeof v === "string" ? (JSON.parse(v) as MicLockState) : v;
    return { locked: Boolean(s.locked), allowed: Array.isArray(s.allowed) ? s.allowed.map(String) : [], by: s.by, at: s.at };
  } catch (err) {
    // Unreadable: nobody is locked out by a KV blip.
    console.warn("[micLock] could not read the lock", eventId, err);
    return UNLOCKED;
  }
}

export async function saveMicLock(eventId: string, s: MicLockState): Promise<void> {
  await kv.set(key(eventId), JSON.stringify(s), { ex: KEEP_S });
}

/* -------------------------------------------------------------------------- */
/*  Applying it to a LiveKit room                                              */
/* -------------------------------------------------------------------------- */

/** A participant as LiveKit's room service gives it (the fields used). */
export interface LkParticipant {
  identity: string;
  metadata?: string;
  /** ParticipantInfo.Kind: 0 standard; 1 ingress, 2 egress, 3 SIP, 4 agent. */
  kind?: number | string;
  permission?: { canPublish?: boolean; canSubscribe?: boolean; canPublishData?: boolean; canPublishSources?: number[]; [k: string]: unknown };
}

/** The part of LiveKit's RoomServiceClient used here (a fake in tests). */
export interface LkRoomService {
  listParticipants(room: string): Promise<LkParticipant[]>;
  updateParticipant(room: string, identity: string, options: { permission?: Record<string, unknown> }): Promise<unknown>;
  sendData(room: string, data: Uint8Array, kind: number, options?: { topic?: string; destinationIdentities?: string[] }): Promise<unknown>;
}

function wireRoleOf(p: LkParticipant): string | undefined {
  try {
    const md = p.metadata ? (JSON.parse(p.metadata) as { role?: unknown }) : {};
    return typeof md.role === "string" ? md.role : undefined;
  } catch {
    return undefined;
  }
}

/** A person, not a service: only standard participants are ever locked. */
export function isPerson(p: LkParticipant): boolean {
  if (SERVICE_IDENTITY.test(p.identity)) return false;
  const k = p.kind;
  return k === undefined || k === 0 || k === "STANDARD" || k === "standard";
}

export interface ApplyResult {
  /** Participants whose microphone permission was changed now. */
  changed: number;
  /** Already as they should be, elevated, or services. */
  unchanged: number;
  failed: number;
}

/**
 * Make each participant's microphone permission match the state. `only`
 * limits it to one account's tabs (allow / lock again / a role change).
 */
export async function applyMicLock(
  svc: LkRoomService,
  room: string,
  state: MicLockState,
  opts: { only?: string; list?: LkParticipant[] } = {},
): Promise<ApplyResult> {
  const list = opts.list ?? (await svc.listParticipants(room));
  const r: ApplyResult = { changed: 0, unchanged: 0, failed: 0 };
  const only = opts.only ? baseIdentity(opts.only).toLowerCase() : null;
  await Promise.all(
    list.map(async (p) => {
      if (only && baseIdentity(p.identity).toLowerCase() !== only) return;
      if (!isPerson(p)) {
        r.unchanged++;
        return;
      }
      const want = accessFor(state, { role: wireRoleOf(p), userId: p.identity });
      if (permissionIsAsWanted(p.permission, want)) {
        r.unchanged++;
        return;
      }
      const base = p.permission ?? { canPublish: true, canSubscribe: true, canPublishData: true };
      try {
        await svc.updateParticipant(room, p.identity, { permission: withAccess(base, want) });
        r.changed++;
      } catch (err) {
        // Usually someone who left between the list and the update.
        console.warn("[micLock] could not update", p.identity, err);
        r.failed++;
      }
    }),
  );
  return r;
}

/** LiveKit's room service from the environment, or null when it is not set up. */
export async function liveKitService(): Promise<LkRoomService | null> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const ws = process.env.LIVEKIT_WS_URL || process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !ws) return null;
  const { RoomServiceClient } = await import("livekit-server-sdk");
  return new RoomServiceClient(ws.replace(/^ws/, "http"), apiKey, apiSecret) as unknown as LkRoomService;
}

/** Tell everyone's screen the new state (moderators' menus follow it). */
export async function announceMicLock(svc: LkRoomService, room: string, state: MicLockState): Promise<void> {
  const payload = new TextEncoder().encode(JSON.stringify({ type: "mic_lock", locked: state.locked, allowed: state.allowed }));
  try {
    await svc.sendData(room, payload, 0, { topic: MIC_LOCK_TOPIC });
  } catch (err) {
    console.warn("[micLock] could not announce", room, err);
  }
}

/**
 * One participant, as LiveKit's webhook describes them on joining or on
 * publishing a microphone: make their permission match the state. Covers a
 * reconnect that reuses a token from before the lock (or the unlock). Never
 * throws: the webhook's other work must go on.
 */
export async function enforceMicLockFor(eventId: string, room: string, p: LkParticipant, svc?: LkRoomService | null): Promise<ApplyResult | null> {
  try {
    const state = await getMicLock(eventId);
    const service = svc === undefined ? await liveKitService() : svc;
    if (!service) return null;
    return await applyMicLock(service, room, state, { list: [p] });
  } catch (err) {
    console.warn("[micLock] could not enforce on", p.identity, err);
    return null;
  }
}

/**
 * Grant for a join token while the meeting is locked: nothing may be
 * published, or only the microphone for someone allowed to talk. Null when
 * this person is not locked. (The SDK writes the sources into the token by name.)
 */
export function lockedTokenGrant(
  state: MicLockState,
  who: { role?: string | null; userId: string },
): Pick<VideoGrant, "canPublish" | "canPublishSources"> | null {
  const access = accessFor(state, who);
  if (access === "none") return { canPublish: false };
  if (access === "mic") return { canPublishSources: [...MIC_ONLY] as unknown as VideoGrant["canPublishSources"] };
  return null;
}
