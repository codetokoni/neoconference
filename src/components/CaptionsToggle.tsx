"use client";

// src/components/CaptionsToggle.tsx
//
// Toolbar pill for the in-room live-captions feature. Host and co-host can
// click to toggle live captions ON / OFF; everyone else sees the pill as a
// read-only status indicator ("Captions: ON" or no pill when off).
//
// State synchronization model:
// - Host clicks ON: POST /api/livekit/captions/dispatch to spin up the
//   captions-worker agent in this room, then publish a reliable data
//   message { type: 'captions', enabled: true } so all clients (and the
//   worker) flip to the on state.
// - Host clicks OFF: publish { type: 'captions', enabled: false }. The
//   worker stays connected but stops forwarding audio to Deepgram. We
//   don't tear down the dispatch immediately because cycling on/off is
//   common during a meeting.
// - Non-host clients receive the data message and update their local UI
//   indicator only - they cannot toggle.
// - On mount we don't know the initial state; the worker, when present,
//   periodically rebroadcasts the current state so late joiners catch up.
//
// Must be rendered inside a <LiveKitRoom> so useRoomContext() works.

import { useEffect, useState, useCallback } from 'react';
import { useRoomContext, useLocalParticipant } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';

type Props = {
  roomRole: string;
  roomName: string;
  eventSlug?: string;
};

export default function CaptionsToggle({ roomRole, roomName, eventSlug }: Props) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canControl = roomRole === 'host' || roomRole === 'cohost';

  // Listen for room-wide captions state changes.
  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as {
          type?: string;
          enabled?: boolean;
        };
        if (msg?.type === 'captions' && typeof msg.enabled === 'boolean') {
          setEnabled(msg.enabled);
        }
      } catch {
        // ignore non-JSON packets
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  const broadcastState = useCallback(
    async (next: boolean) => {
      try {
        const payload = new TextEncoder().encode(
          JSON.stringify({ type: 'captions', enabled: next }),
        );
        await localParticipant.publishData(payload, { reliable: true });
      } catch (e) {
        console.error('[captions] broadcast failed', e);
      }
    },
    [localParticipant],
  );

  const toggle = useCallback(async () => {
    if (busy || !canControl) return;
    setBusy(true);
    setError(null);
    const next = !enabled;
    try {
      if (next) {
        // Spin up the worker (idempotent server-side).
        const res = await fetch('/api/livekit/captions/dispatch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ room: roomName, eventSlug }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          throw new Error(data?.error || ('HTTP ' + res.status));
        }
      }
      // Optimistically flip locally, then broadcast.
      setEnabled(next);
      await broadcastState(next);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error('[captions] toggle failed', e);
      // Roll back optimistic state on error.
      setEnabled(enabled);
    } finally {
      setBusy(false);
      // Clear error toast after a few seconds.
      setTimeout(() => setError(null), 5000);
    }
  }, [busy, canControl, enabled, broadcastState, roomName, eventSlug]);

  // Hide the pill entirely if captions are off AND user can't control them.
  // This keeps the toolbar uncluttered for normal attendees until a host
  // turns captions on.
  if (!enabled && !canControl) return null;

  const labelOn = busy ? 'Captions …' : enabled ? 'CC ● ON' : 'CC';
  const labelOff = 'CC ● ON';

  return (
    <div className="fixed bottom-24 right-4 z-50 flex items-center gap-1">
      <button
        type="button"
        data-room-chrome="true"
        onClick={canControl ? toggle : undefined}
        disabled={busy}
        aria-pressed={enabled}
        aria-disabled={!canControl}
        title={
          canControl
            ? enabled
              ? 'Turn live captions off'
              : 'Turn live captions on'
            : enabled
              ? 'Live captions are on (only hosts can toggle)'
              : 'Live captions are off'
        }
        className={
          'px-3 py-1.5 text-xs rounded border shadow-sm transition ' +
          (enabled
            ? 'bg-cyan-500/90 text-white border-cyan-200/40 hover:bg-cyan-500'
            : 'bg-black text-white border-white/30 hover:bg-zinc-800') +
          (canControl ? ' cursor-pointer' : ' cursor-default opacity-90')
        }
        style={{ pointerEvents: canControl ? 'auto' : 'none' }}
      >
        {canControl ? labelOn : labelOff}
      </button>
      {error && (
        <span
          role="alert"
          className="text-[11px] text-rose-300 ml-1"
          style={{ maxWidth: 200 }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
