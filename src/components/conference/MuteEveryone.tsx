'use client';

// "Mute everyone" / "Unmute everyone" in the meeting toolbar, right of Leave,
// for the Owner, Hosts and Moderators. It is the People panel's "Lock /
// Unlock participant microphones" (src/app/api/livekit/mic-lock): the server
// checks the caller's role, LiveKit takes the microphones away and refuses
// them back (src/lib/micLock.ts), and every moderator's button follows the
// state the server confirmed (micLockClient.ts). A participant's side — the
// lock on their Mic button and why — is MicLockNotice and the control bars.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff } from 'lucide-react';
import { useRoomContext, useRoomInfo } from '@livekit/components-react';
import { RoomEvent, type Participant } from 'livekit-client';
import { useParams, useSearchParams } from 'next/navigation';
import { postMicLock, useMicLockState } from './micLockClient';

function wireRole(metadata: string | undefined): string | undefined {
  try {
    const md = metadata ? JSON.parse(metadata) : null;
    return typeof md?.role === 'string' ? md.role : undefined;
  } catch {
    return undefined;
  }
}

/** Owner, Host or Moderator: who the button is for (the server checks again). */
function useCanMuteEveryone(): boolean {
  const room = useRoomContext();
  const [role, setRole] = useState<string | undefined>(() => wireRole(room.localParticipant.metadata));
  useEffect(() => {
    const read = () => setRole(wireRole(room.localParticipant.metadata));
    read();
    const onChange = (_md: string | undefined, p: Participant) => {
      if (p.identity === room.localParticipant.identity) read();
    };
    room.on(RoomEvent.ParticipantMetadataChanged, onChange).on(RoomEvent.Connected, read);
    return () => {
      room.off(RoomEvent.ParticipantMetadataChanged, onChange).off(RoomEvent.Connected, read);
    };
  }, [room]);
  return role === 'host' || role === 'cohost';
}

/** The meeting's slug, as the room page has it (/room/<room>?event=<slug>). */
function useMeetingSlug(): string | undefined {
  const params = useParams();
  const search = useSearchParams();
  const { name } = useRoomInfo();
  const fromPath = params && typeof params.name === 'string' ? decodeURIComponent(params.name) : undefined;
  return search?.get('event') || fromPath || name || undefined;
}

/** The toggle's state and press, shared by both toolbars. */
function useMuteEveryone() {
  const canControl = useCanMuteEveryone();
  const slug = useMeetingSlug();
  const { name: room } = useRoomInfo();
  const { locked, refresh } = useMicLockState(canControl ? slug : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(t);
  }, [error]);

  const toggle = useCallback(async () => {
    if (busy || !slug) return;
    setBusy(true);
    setError(null);
    // The label changes only when the server says it did (refresh, and the
    // "mic_lock" message every moderator's screen gets); a failure keeps it.
    const msg = await postMicLock(slug, room || undefined, locked ? 'unlock' : 'lock');
    if (msg) setError(msg);
    refresh();
    setBusy(false);
  }, [busy, slug, room, locked, refresh]);

  return { canControl, locked, busy, error, toggle };
}

/** A message above the toolbar, outside it (the bar is transformed, which traps fixed children). */
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
        width: 'max-content',
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

/** The computer's toolbar (NeoControlBar): the last button, right of Leave. */
export function MuteEveryoneControlBarButton() {
  const { canControl, locked, busy, error, toggle } = useMuteEveryone();
  if (!canControl) return null;
  const label = locked ? 'Unmute everyone' : 'Mute everyone';
  return (
    <>
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
        {locked ? <Mic width={16} height={16} aria-hidden /> : <MicOff width={16} height={16} aria-hidden />}
        <span className="max-[760px]:hidden">{label}</span>
      </button>
      {error && <Toast text={error} bottom={104} />}
    </>
  );
}

/**
 * The phone layout's toolbar (MobileControlBar): the same toggle as a round
 * icon button. With words it made the bar 381px wide on a 360px phone and
 * ran off the edge; its name is still what a screen reader says, and it is
 * lit while the lock is on, as on a computer.
 */
export function MuteEveryoneMobileButton() {
  const { canControl, locked, busy, error, toggle } = useMuteEveryone();
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
