'use client';

// The browser's side of locked microphones (src/lib/micLock.ts).
//
// Whether this person's microphone is locked is LiveKit's own permission
// (canPublishSources leaves the microphone out), which the server changes and
// LiveKit delivers to the client, also after a reconnect. Every way of
// turning the microphone on goes through enableMicrophone(): while locked it
// does nothing but tell the person why (MicLockNotice shows the message).
//
// Moderators' menus follow the meeting-wide state (locked, who is allowed)
// from GET /api/livekit/mic-lock and the "mic_lock" data message the server
// sends on every change.

import { useCallback, useEffect, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, type LocalParticipant } from 'livekit-client';

export const MIC_LOCKED_MESSAGE = 'Your microphone and camera are locked. An Owner, Host, or Moderator can allow you to turn them on.';
export const MIC_ALLOWED_MESSAGE = 'You can now turn your microphone and camera on.';
/** Allowed to talk while the meeting stays locked: the microphone only. */
export const MIC_ONLY_ALLOWED_MESSAGE = 'You can now unmute. Your camera stays locked.';
export const CAM_LOCKED_MESSAGE = 'Your camera is locked. An Owner, Host, or Moderator can unlock it.';
/** The window event a blocked attempt raises, for MicLockNotice. */
export const MIC_LOCKED_EVENT = 'neo:mic-locked';
const MICROPHONE = 2; // LiveKit's TrackSource.MICROPHONE
const CAMERA = 1; // LiveKit's TrackSource.CAMERA

type Perms = { canPublish?: boolean; canPublishSources?: number[] } | undefined;

/** Whether LiveKit lets this participant publish a microphone. No permissions yet: yes. */
export function micPermitted(perms: Perms): boolean {
  if (!perms) return true;
  if (perms.canPublish === false) return false;
  const list = (perms.canPublishSources ?? []).map(Number);
  return list.length === 0 || list.includes(MICROPHONE);
}

/**
 * Whether LiveKit lets this participant publish a camera. Someone allowed to
 * talk while the meeting is locked may publish the microphone only.
 */
export function camPermitted(perms: Perms): boolean {
  if (!perms) return true;
  if (perms.canPublish === false) return false;
  const list = (perms.canPublishSources ?? []).map(Number);
  return list.length === 0 || list.includes(CAMERA);
}

/** Say why the microphone stayed off. */
export function noteMicLocked(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(MIC_LOCKED_EVENT));
}

/** Say why the camera stayed off. */
export function noteCamLocked(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(MIC_LOCKED_EVENT, { detail: 'camera' }));
}

/**
 * Turn the microphone on or off. Turning it on while it is locked does
 * nothing but say why; returns whether it was done.
 */
export async function enableMicrophone(lp: LocalParticipant | null | undefined, on: boolean): Promise<boolean> {
  if (!lp) return false;
  if (on && !micPermitted(lp.permissions as Perms)) {
    noteMicLocked();
    return false;
  }
  try {
    await lp.setMicrophoneEnabled(on);
    return true;
  } catch {
    // Refused by LiveKit (the lock arrived in between): say why.
    if (on && !micPermitted(lp.permissions as Perms)) noteMicLocked();
    return false;
  }
}

/**
 * Turn the camera on or off. The lock takes the camera too, also from
 * someone allowed to talk: turning it on while locked does nothing but say why.
 */
export async function enableCamera(lp: LocalParticipant | null | undefined, on: boolean): Promise<boolean> {
  if (!lp) return false;
  if (on && !camPermitted(lp.permissions as Perms)) {
    noteCamLocked();
    return false;
  }
  try {
    await lp.setCameraEnabled(on);
    return true;
  } catch {
    if (on && !camPermitted(lp.permissions as Perms)) noteCamLocked();
    return false;
  }
}

/** Whether this person's microphone is locked now (follows LiveKit's permission). */
export function useMicLocked(): boolean {
  return usePermissionLock(micPermitted);
}

/** Whether this person's camera is locked now (also while allowed to talk). */
export function useCamLocked(): boolean {
  return usePermissionLock(camPermitted);
}

function usePermissionLock(permitted: (perms: Perms) => boolean): boolean {
  const room = useRoomContext();
  const read = useCallback(() => !permitted(room?.localParticipant?.permissions as Perms), [room, permitted]);
  const [locked, setLocked] = useState(read);
  useEffect(() => {
    if (!room) return;
    const update = () => setLocked(read());
    update();
    room.on(RoomEvent.ParticipantPermissionsChanged, update).on(RoomEvent.Connected, update).on(RoomEvent.Reconnected, update);
    return () => {
      room.off(RoomEvent.ParticipantPermissionsChanged, update).off(RoomEvent.Connected, update).off(RoomEvent.Reconnected, update);
    };
  }, [room, read]);
  return locked;
}

export interface MicLockView {
  locked: boolean;
  /** Account ids allowed to unmute while locked (moderators only; null for others). */
  allowed: string[] | null;
}

/**
 * The meeting's lock as moderators' menus show it: read on opening and after
 * a reconnect, and kept current by the server's "mic_lock" message.
 */
export function useMicLockState(slug: string | undefined): MicLockView & { refresh: () => void } {
  const room = useRoomContext();
  const [view, setView] = useState<MicLockView>({ locked: false, allowed: null });
  const refresh = useCallback(() => {
    if (!slug) return;
    fetch(`/api/livekit/mic-lock?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { locked?: boolean; allowed?: string[] } | null) => {
        if (j) setView({ locked: Boolean(j.locked), allowed: Array.isArray(j.allowed) ? j.allowed : null });
      })
      .catch(() => {});
  }, [slug]);
  useEffect(() => {
    refresh();
    if (!room) return;
    const onData = (payload: Uint8Array, _p?: unknown, _k?: unknown, topic?: string) => {
      if (topic !== 'mic_lock') return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as { type?: string; locked?: boolean; allowed?: string[] };
        if (msg.type !== 'mic_lock') return;
        setView((v) => ({ locked: Boolean(msg.locked), allowed: v.allowed === null ? null : Array.isArray(msg.allowed) ? msg.allowed : [] }));
      } catch {
        /* not ours */
      }
    };
    room.on(RoomEvent.DataReceived, onData).on(RoomEvent.Reconnected, refresh);
    return () => {
      room.off(RoomEvent.DataReceived, onData).off(RoomEvent.Reconnected, refresh);
    };
  }, [room, refresh]);
  return { ...view, refresh };
}

export type MicLockAction = 'lock' | 'unlock' | 'allow' | 'relock';

/** Ask the server to lock, unlock, allow or lock again; "" when done, else a message. */
export async function postMicLock(slug: string, room: string | undefined, action: MicLockAction, participantIdentity?: string): Promise<string> {
  try {
    const r = await fetch('/api/livekit/mic-lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, ...(room ? { room } : {}), action, ...(participantIdentity ? { participantIdentity } : {}) }),
    });
    if (r.ok) return '';
    const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
    if (r.status === 403) return 'Only an Owner, Host or Moderator can do that.';
    return j.message || 'That did not work. Try again.';
  } catch {
    return 'That did not work. Check your connection and try again.';
  }
}

/** The account id in a LiveKit identity ("user_x#tab" → "user_x"). */
export const accountOf = (identity: string): string => identity.split('#')[0];
