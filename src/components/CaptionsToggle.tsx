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

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRoomContext, useLocalParticipant, useParticipants } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';

// How long to wait for the captions worker to join after a host clicks
// ON before surfacing "worker did not join" as a warning. Railway
// cold-starts can take 5-8s; keep the wait generous so we don't
// false-positive on a slow spin-up.
const WORKER_JOIN_TIMEOUT_MS = 15_000;

type Props = {
  roomRole: string;
  roomName: string;
  eventSlug?: string;
};

export default function CaptionsToggle({ roomRole, roomName, eventSlug }: Props) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const participants = useParticipants();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workerMissing, setWorkerMissing] = useState(false);

  const canControl = roomRole === 'host';

  // Detect the captions worker via LiveKit's isAgent flag. Any agent-
  // kind participant in the room counts — we don't tie this to a
  // specific identity so a name change on the worker side doesn't
  // silently break the check.
  const agentPresent = participants.some((p) => {
    // LiveKit 2.x exposes `isAgent` on both local and remote participants.
    return (p as { isAgent?: boolean }).isAgent === true;
  });
  const prevAgentPresent = useRef(agentPresent);

  // If captions are ON but no agent has joined within a generous window,
  // surface a warning. Reset whenever the room composition changes or
  // captions toggle. Clears immediately when the agent shows up.
  useEffect(() => {
    if (!enabled) {
      setWorkerMissing(false);
      return;
    }
    if (agentPresent) {
      setWorkerMissing(false);
      return;
    }
    const id = window.setTimeout(() => setWorkerMissing(true), WORKER_JOIN_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [enabled, agentPresent]);

  // Race fix: the toggle dispatches the worker AND broadcasts
  // { captions: enabled: true } immediately. The worker takes ~5-8s to
  // join (Railway cold start), and by then the broadcast has already
  // fired — so it joins the room but never receives the "start
  // transcribing" signal, sits silent, and captions never arrive.
  //
  // This effect resends the current state one time whenever the agent
  // transitions from missing to present. Host-only — every non-host in
  // the room broadcasting on the same signal would just be noise.
  //
  // Guarded by prevAgentPresent so we don't re-fire on every render.

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

  // Re-arm broadcast on agent arrival. Placed above the useCallback
  // that defines broadcastState so the dependency reference is stable
  // — see the effect body for the actual work.
  const broadcastStateRef = useRef<((next: boolean) => Promise<void>) | null>(null);
  useEffect(() => {
    const wasAbsent = !prevAgentPresent.current;
    prevAgentPresent.current = agentPresent;
    if (!canControl) return;
    if (!wasAbsent || !agentPresent || !enabled) return;
    broadcastStateRef.current?.(true).catch(() => {
      // best-effort; broadcastState logs its own error
    });
  }, [agentPresent, enabled, canControl]);

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
  // Keep the ref pointing at the latest broadcastState so the
  // agent-arrival effect above always uses the current closure.
  useEffect(() => {
    broadcastStateRef.current = broadcastState;
  }, [broadcastState]);

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

  const labelOn = busy
    ? 'Captions …'
    : enabled
      ? workerMissing
        ? 'CC ● WORKER OFFLINE'
        : agentPresent
          ? 'CC ● ON'
          : 'CC ● WAITING…'
      : 'CC';
  const labelOff = enabled
    ? workerMissing
      ? 'CC ● WORKER OFFLINE'
      : agentPresent
        ? 'CC ● ON'
        : 'CC ● WAITING…'
    : 'CC ● ON';

  // Pill colour tracks state so operators can see at a glance:
  //   OFF     — black
  //   WAITING — amber (dispatched, worker hasn't joined yet — cold start)
  //   OFFLINE — rose (past timeout; likely Railway/Deepgram infra issue)
  //   ON      — cyan (worker present)
  const pillClass = enabled
    ? workerMissing
      ? 'bg-rose-600/90 text-white border-rose-300/40'
      : agentPresent
        ? 'bg-cyan-500/90 text-white border-cyan-200/40 hover:bg-cyan-500'
        : 'bg-amber-500/90 text-black border-amber-200/40'
    : 'bg-black text-white border-white/30 hover:bg-zinc-800';

  return (
    <div className="fixed bottom-36 right-4 z-50 flex items-center gap-1">
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
              ? workerMissing
                ? 'Captions worker did not join. Check Railway service and Deepgram quota / key.'
                : agentPresent
                  ? 'Turn live captions off'
                  : 'Waiting for captions worker to join (cold start can take a few seconds)…'
              : 'Turn live captions on'
            : enabled
              ? workerMissing
                ? 'Captions enabled but the transcription worker did not join. Ask the host to toggle off + on.'
                : 'Live captions are on (only hosts can toggle)'
              : 'Live captions are off'
        }
        className={
          'px-3 py-1.5 text-xs rounded border shadow-sm transition ' +
          pillClass +
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
