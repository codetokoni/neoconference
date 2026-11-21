'use client';

// The Owner's, Hosts' and Moderators' microphone controls in the meeting
// toolbar, right of Leave. Two different things:
//   - "Mute all": mutes everyone but the Owner, Hosts and Moderators once
//     (POST /api/livekit/muteAll). People can unmute themselves straight
//     away.
//   - "Lock" / "Unlock": the People panel's "Lock / Unlock microphones and
//     cameras" (src/app/api/livekit/mic-lock). LiveKit takes everyone else's
//     microphone, camera and screen away and refuses them back until it is
//     unlocked (src/lib/micLock.ts); every moderator's button follows the
//     state the server confirmed (micLockClient.ts).
// A participant's side of the lock (the lock on their Mic button and why)
// is MicLockNotice and the control bars.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, LockOpen, MicOff } from 'lucide-react';
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

/** Owner, Host or Moderator: who the controls are for (the server checks again). */
export function useIsModerator(): boolean {
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

type Note = { text: string; error: boolean };

/** Both controls' state and presses, shared by the two toolbars. */
function useMicControls() {
  const isModerator = useIsModerator();
  const slug = useMeetingSlug();
  const { name: room } = useRoomInfo();
  const { locked, refresh } = useMicLockState(isModerator ? slug : undefined);
  const [busy, setBusy] = useState<null | 'mute' | 'lock'>(null);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), note.error ? 6000 : 3000);
    return () => window.clearTimeout(t);
  }, [note]);

  /** Once: everyone but the Owner, Hosts and Moderators; they can unmute themselves. */
  const muteAll = useCallback(async () => {
    if (busy || !slug) return;
    setBusy('mute');
    setNote(null);
    try {
      const r = await fetch('/api/livekit/muteAll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomName: slug }),
      });
      const j = (await r.json().catch(() => ({}))) as { muted?: number; message?: string };
      if (r.ok) setNote({ text: 'Everyone else is muted. They can unmute themselves.', error: false });
      else if (r.status === 403) setNote({ text: 'Only an Owner, Host or Moderator can do that.', error: true });
      else setNote({ text: j.message || "Couldn't mute everyone. Try again.", error: true });
    } catch {
      setNote({ text: "Couldn't mute everyone. Check your connection and try again.", error: true });
    } finally {
      setBusy(null);
    }
  }, [busy, slug]);

  /** Lock or unlock; the label changes only when the server says it did. */
  const toggleLock = useCallback(async () => {
    if (busy || !slug) return;
    setBusy('lock');
    setNote(null);
    const msg = await postMicLock(slug, room || undefined, locked ? 'unlock' : 'lock');
    if (msg) setNote({ text: msg, error: true });
    refresh();
    setBusy(null);
  }, [busy, slug, room, locked, refresh]);

  return { isModerator, locked, busy, note, muteAll, toggleLock };
}

/** A message above the toolbar, outside it (the bar is transformed, which traps fixed children). */
function Toast({ note, bottom }: { note: Note; bottom: number }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      role={note.error ? 'alert' : 'status'}
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
        background: note.error ? 'rgba(127,29,29,0.92)' : 'rgba(6,12,24,0.92)',
        border: note.error ? '1px solid rgba(248,113,113,0.5)' : '1px solid rgba(103,232,249,0.35)',
        color: note.error ? '#fee2e2' : '#e6f7ff',
        fontSize: 13,
        textAlign: 'center',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}
    >
      {note.text}
    </div>,
    document.body,
  );
}

/** The computer's toolbar (NeoControlBar): "Mute all", then "Lock", right of Leave. */
export function HostMicControlBarButtons() {
  const { isModerator, locked, busy, note, muteAll, toggleLock } = useMicControls();
  if (!isModerator) return null;
  const lockLabel = locked ? 'Unlock' : 'Lock';
  return (
    <>
      <button
        type="button"
        className="lk-button neo-mute-all"
        aria-label="Mute everyone"
        title="Mute everyone but the Owner, Hosts and Moderators. They can unmute themselves."
        aria-busy={busy === 'mute'}
        disabled={busy !== null}
        onClick={muteAll}
      >
        <MicOff width={16} height={16} aria-hidden />
        <span className="max-[760px]:hidden">Mute all</span>
      </button>
      <button
        type="button"
        className="lk-button neo-lock-mics"
        data-locked={locked ? 'true' : 'false'}
        aria-label={locked ? 'Unlock microphones and cameras' : 'Lock microphones and cameras'}
        title={locked ? 'Let participants turn their microphones and cameras back on' : "Turn off participants' microphones and cameras and keep them off"}
        aria-busy={busy === 'lock'}
        disabled={busy !== null}
        onClick={toggleLock}
      >
        {locked ? <LockOpen width={16} height={16} aria-hidden /> : <Lock width={16} height={16} aria-hidden />}
        <span className="max-[760px]:hidden">{lockLabel}</span>
      </button>
      {note && <Toast note={note} bottom={104} />}
    </>
  );
}

const roundBtn = 'flex items-center justify-center rounded-full w-8 h-8 border-[0.5px]';
const roundIdle = 'bg-[rgba(255,255,255,0.06)] border-[rgba(255,255,255,0.1)]';
const roundLit = 'bg-[rgba(251,191,36,0.18)] border-[rgba(251,191,36,0.5)]';

/**
 * The phone layout's toolbar (MobileControlBar): the same two as round icon
 * buttons. With words they ran off a 360px phone; their names are what a
 * screen reader says, and the lock is lit while it is on, as on a computer.
 */
export function HostMicControlsMobile() {
  const { isModerator, locked, busy, note, muteAll, toggleLock } = useMicControls();
  if (!isModerator) return null;
  const lockName = locked ? 'Unlock microphones and cameras' : 'Lock microphones and cameras';
  return (
    <>
      <button
        type="button"
        aria-label="Mute everyone"
        title="Mute all"
        aria-busy={busy === 'mute'}
        disabled={busy !== null}
        onClick={muteAll}
        className={`${roundBtn} ${roundIdle}`}
        style={{ opacity: busy === 'mute' ? 0.6 : 1, flex: '0 0 auto' }}
      >
        <MicOff className="w-4 h-4 text-white" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={lockName}
        title={lockName}
        aria-busy={busy === 'lock'}
        disabled={busy !== null}
        onClick={toggleLock}
        className={`${roundBtn} ${locked ? roundLit : roundIdle}`}
        style={{ opacity: busy === 'lock' ? 0.6 : 1, flex: '0 0 auto' }}
      >
        {locked ? <LockOpen className="w-4 h-4 text-amber-200" aria-hidden /> : <Lock className="w-4 h-4 text-white" aria-hidden />}
      </button>
      {note && <Toast note={note} bottom={84} />}
    </>
  );
}
