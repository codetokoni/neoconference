'use client';

// "Mute everyone" / "Unmute everyone" in the meeting toolbar, and what a
// participant sees while the lock is on. The lock itself is the server's
// (src/app/api/livekit/micLock/route.ts, src/lib/micLock.ts): LiveKit takes
// an ordinary participant's microphone away and refuses it back, so these
// only show it.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff } from 'lucide-react';
import { useLocalParticipant, useRoomContext, useRoomInfo } from '@livekit/components-react';
import { ParticipantEvent, RoomEvent, type Participant } from 'livekit-client';

/** TrackSource.MICROPHONE in LiveKit's protocol (permissions carry the number). */
const MICROPHONE_SOURCE = 2;

function wireRole(metadata: string | undefined): string | undefined {
  try {
    const md = metadata ? JSON.parse(metadata) : null;
    return typeof md?.role === 'string' ? md.role : undefined;
  } catch {
    return undefined;
  }
}

/** Owner, host or moderator: the people the button is for (the server checks again). */
function useCanMuteEveryone(): boolean {
  const room = useRoomContext();
  const [role, setRole] = useState<string | undefined>(() => wireRole(room.localParticipant.metadata));
  useEffect(() => {
    const read = () => setRole(wireRole(room.localParticipant.metadata));
    read();
    const onChange = (_md: string | undefined, p: Participant) => {
      if (p.identity === room.localParticipant.identity) read();
    };
    room.on(RoomEvent.ParticipantMetadataChanged, onChange);
    room.on(RoomEvent.Connected, read);
    return () => {
      room.off(RoomEvent.ParticipantMetadataChanged, onChange);
      room.off(RoomEvent.Connected, read);
    };
  }, [room]);
  return role === 'host' || role === 'cohost';
}

function lockFromMetadata(metadata: string | undefined): boolean | null {
  try {
    const md = metadata ? JSON.parse(metadata) : null;
    return typeof md?.micLock === 'boolean' ? md.micLock : null;
  } catch {
    return null;
  }
}

/**
 * The meeting's lock as the server last confirmed it: read once, then from
 * the room's metadata, which the server rewrites on every change, so every
 * host's and moderator's button shows the same thing. A press that fails
 * leaves it as it was and says why.
 */
export function useMeetingMicLock(enabled: boolean) {
  const { name: roomName, metadata } = useRoomInfo();
  const [locked, setLocked] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fromRoom = lockFromMetadata(metadata);
    if (fromRoom !== null) setLocked(fromRoom);
  }, [metadata]);

  useEffect(() => {
    if (!enabled || !roomName) return;
    let cancelled = false;
    fetch(`/api/livekit/micLock?room=${encodeURIComponent(roomName)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && typeof j?.locked === 'boolean') setLocked(j.locked);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, roomName]);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(t);
  }, [error]);

  const toggle = useCallback(async () => {
    if (busy || !roomName) return;
    const want = !locked;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/livekit/micLock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomName, locked: want }),
        // The server gives LiveKit 8 s a call; past this something else is wrong.
        signal: AbortSignal.timeout(30_000),
      });
      const j = (await res.json().catch(() => ({}))) as { locked?: unknown; message?: unknown; error?: unknown };
      if (res.ok && typeof j.locked === 'boolean') {
        setLocked(j.locked);
      } else {
        if (typeof j.locked === 'boolean') setLocked(j.locked);
        setError(
          typeof j.message === 'string' && j.message
            ? j.message
            : res.status === 403
              ? 'Only the owner, a host or a moderator can do that.'
              : want
                ? "Couldn't mute everyone. Try again."
                : "Couldn't unmute everyone. Try again.",
        );
      }
    } catch {
      setError(want ? "Couldn't mute everyone. Check your connection and try again." : "Couldn't unmute everyone. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, locked, roomName]);

  return { locked, busy, error, toggle };
}

/** A message above the control bar, outside it (the bar is transformed, which traps fixed children). */
function Toast({ text, bottom }: { text: string; bottom: number }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      role="alert"
      style={{
        position: 'fixed',
        left: '50%',
        bottom,
        transform: 'translateX(-50%)',
        zIndex: 90,
        maxWidth: 'calc(100vw - 32px)',
        padding: '8px 14px',
        borderRadius: 10,
        background: 'rgba(127,29,29,0.92)',
        border: '1px solid rgba(248,113,113,0.5)',
        color: '#fee2e2',
        fontSize: 13,
        textAlign: 'center',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}
    >
      {text}
    </div>,
    document.body,
  );
}

/**
 * The computer's toolbar: the button goes into LiveKit's control bar as its
 * last item, immediately right of Leave.
 */
export function MuteEveryoneControlBarButton() {
  const canControl = useCanMuteEveryone();
  const { locked, busy, error, toggle } = useMeetingMicLock(canControl);
  const [bar, setBar] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!canControl) return;
    const find = () => {
      const el = document.querySelector<HTMLElement>('.lk-video-conference .lk-control-bar');
      setBar((prev) => (prev === el ? prev : el));
      return el;
    };
    if (find()) return;
    const obs = new MutationObserver(() => {
      if (find()) obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [canControl]);

  if (!canControl || !bar) return null;
  const label = locked ? 'Unmute everyone' : 'Mute everyone';
  return (
    <>
      {createPortal(
        <button
          type="button"
          className="lk-button neo-mute-everyone"
          data-locked={locked ? 'true' : 'false'}
          aria-label={label}
          title={locked ? 'Let participants turn their microphones back on' : 'Mute all participants and keep them muted'}
          aria-busy={busy}
          disabled={busy}
          onClick={toggle}
        >
          {locked ? <Mic className="lk-icon" width={16} height={16} aria-hidden /> : <MicOff className="lk-icon" width={16} height={16} aria-hidden />}
          <span>{label}</span>
        </button>,
        bar,
      )}
      {error && <Toast text={error} bottom={104} />}
    </>
  );
}

/**
 * The phone layout's toolbar: the same toggle as a round icon button. With
 * words it made the bar 381px wide on a 360px phone and ran off the edge;
 * its name ("Mute everyone" / "Unmute everyone") is still what a screen
 * reader says, and it is lit while the lock is on, as on a computer.
 */
export function MuteEveryoneMobileButton() {
  const canControl = useCanMuteEveryone();
  const { locked, busy, error, toggle } = useMeetingMicLock(canControl);
  if (!canControl) return null;
  const label = locked ? 'Unmute everyone' : 'Mute everyone';
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-busy={busy}
        disabled={busy}
        onClick={toggle}
        className={`flex items-center justify-center rounded-full w-9 h-9 border-[0.5px] ${
          locked ? 'bg-[rgba(251,191,36,0.18)] border-[rgba(251,191,36,0.5)]' : 'bg-[rgba(255,255,255,0.06)] border-[rgba(255,255,255,0.1)]'
        }`}
        style={{ opacity: busy ? 0.6 : 1, flex: '0 0 auto' }}
      >
        {locked ? <Mic className="w-4 h-4 text-amber-200" aria-hidden /> : <MicOff className="w-4 h-4 text-white" aria-hidden />}
      </button>
      {error && <Toast text={error} bottom={84} />}
    </>
  );
}

/** True while "Mute everyone" keeps this person's microphone off. */
export function useMyMicLocked(): boolean {
  const { localParticipant } = useLocalParticipant();
  const read = useCallback(() => {
    const sources = (localParticipant?.permissions?.canPublishSources ?? []) as Array<number | string>;
    return sources.length > 0 && !sources.some((s) => s === MICROPHONE_SOURCE || s === 'MICROPHONE');
  }, [localParticipant]);
  const [locked, setLocked] = useState(read);
  useEffect(() => {
    if (!localParticipant) return;
    const update = () => setLocked(read());
    update();
    localParticipant.on(ParticipantEvent.ParticipantPermissionsChanged, update);
    return () => {
      localParticipant.off(ParticipantEvent.ParticipantPermissionsChanged, update);
    };
  }, [localParticipant, read]);
  return locked;
}

/**
 * For a participant the host has muted: says why their microphone button is
 * gone (LiveKit's control bar hides a control the participant may not use)
 * or does nothing (the phone layout's).
 */
export function MicLockedNotice() {
  const locked = useMyMicLocked();
  if (!locked || typeof document === 'undefined') return null;
  return createPortal(
    <div
      role="status"
      className="neo-mic-locked-notice"
      style={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 45,
        // At left 50% a fixed box only gets half the screen unless told otherwise.
        width: 'max-content',
        maxWidth: 'calc(100vw - 32px)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 999,
        background: 'rgba(6,12,24,0.8)',
        border: '1px solid rgba(251,191,36,0.4)',
        color: '#fde68a',
        fontSize: 12,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      <MicOff width={14} height={14} aria-hidden style={{ flex: '0 0 auto' }} />
      The host has muted everyone. You can unmute when they allow it.
    </div>,
    document.body,
  );
}
