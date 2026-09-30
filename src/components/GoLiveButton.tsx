'use client';

// src/components/GoLiveButton.tsx
//
// Go Live: stream the meeting itself to YouTube, Facebook, Twitch or an
// RTMP address (src/lib/livestream.ts, /api/livekit/egress/stream). The
// host pastes a stream key, presses Start, and LiveKit sends the meeting's
// composed video and audio there. No OBS.
//
// It used to hand the host StreamLab RTMP credentials to point OBS at —
// the meeting itself was never sent, and production had no StreamLab key.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Radio, X, Plus, Trash2 } from 'lucide-react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { RoomEvent, type Participant } from 'livekit-client';
import {
  STREAM_PLATFORMS,
  destinationProblem,
  liveOnText,
  type StreamDestination,
  type StreamDestinationInput,
  type StreamPlatform,
} from '@/lib/livestream';

type DestinationView = StreamDestination & { status: 'connecting' | 'live' | 'ended' | 'failed'; error?: string };
type StreamStatus =
  | { live: false }
  | { live: true; egressId: string; startedAt: string; egress: string; error?: string; destinations: DestinationView[] };

const INPUT_CLASS =
  'w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:border-cyan-400/60 focus:outline-none';

export default function GoLiveButton({
  roomName,
  eventSlug,
  roomRole,
}: {
  roomName: string;
  eventSlug?: string;
  roomRole?: string;
}) {
  // The event's slug is what the stream route wants; the room name is the
  // slug for every meeting that owns its room.
  const slug = eventSlug || roomName;
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const isHost = roomRole === 'host' || roomRole === 'cohost';

  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<StreamStatus>({ live: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<StreamDestinationInput[]>([{ platform: 'youtube', key: '', label: '' }]);
  // What others were told: "Live on YouTube", from the host's data packet.
  const [remote, setRemote] = useState<{ by: string; on: string[] } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Livestream is a plan feature (Enterprise). The server refuses without
  // it; reading the token's planLimits shows the lock before a failed POST.
  const [planAllows, setPlanAllows] = useState<boolean>(true);
  useEffect(() => {
    try {
      const md = JSON.parse(localParticipant?.metadata || '{}') as { planLimits?: { livestream?: boolean } };
      if (typeof md.planLimits?.livestream === 'boolean') setPlanAllows(md.planLimits.livestream);
    } catch {
      // Malformed metadata: leave it to the server.
    }
  }, [localParticipant?.metadata]);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/livekit/egress/stream?room=' + encodeURIComponent(slug));
      if (!r.ok) return;
      const j = (await r.json()) as StreamStatus & { ok: boolean };
      setStatus(j.live ? j : { live: false });
    } catch {
      // Left as it was; the next poll will say.
    }
  }, [slug]);

  // Known on arrival (a reload mid-stream), and kept fresh while live or
  // while the panel is open.
  useEffect(() => {
    if (!isHost) return;
    void refresh();
  }, [isHost, refresh]);
  useEffect(() => {
    if (!isHost || !(status.live || open)) return;
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [isHost, status.live, open, refresh]);

  // Everyone else hears about it on the data channel, as with recording.
  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array, participant?: Participant) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as {
          type?: string;
          active?: boolean;
          by?: string;
          on?: string[];
        };
        if (msg?.type !== 'golive') return;
        setRemote(
          msg.active ? { by: msg.by || participant?.name || participant?.identity || 'A host', on: msg.on || [] } : null
        );
      } catch {
        // Not JSON: not ours.
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  const tell = useCallback(
    async (active: boolean, on: string[]) => {
      try {
        const by = localParticipant?.name || localParticipant?.identity || 'A host';
        await localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'golive', active, by, on })), {
          reliable: true,
        });
      } catch (e) {
        console.error('publishData golive failed', e);
      }
    },
    [localParticipant]
  );

  const start = async () => {
    setError(null);
    const problems = pending.map(destinationProblem).filter(Boolean);
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/livekit/egress/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: slug, destinations: pending }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string; destinations?: StreamDestination[] };
      if (!r.ok || !j.ok) {
        setError(j.message || j.error || `HTTP ${r.status}`);
        return;
      }
      // The keys have gone to LiveKit; nothing here should keep them.
      setPending([{ platform: 'youtube', key: '', label: '' }]);
      await refresh();
      await tell(true, (j.destinations || []).map((d) => d.label));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/livekit/egress/stream', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: slug }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        setError(j.message || j.error || `HTTP ${r.status}`);
        return;
      }
      setStatus({ live: false });
      await tell(false, []);
    } finally {
      setBusy(false);
    }
  };

  const liveLine = useMemo(() => {
    if (status.live) return liveOnText(status.destinations);
    if (remote) return liveOnText(remote.on.map((label) => ({ platform: 'rtmp' as const, label })));
    return null;
  }, [status, remote]);

  const update = (i: number, patch: Partial<StreamDestinationInput>) =>
    setPending((list) => list.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  return (
    <>
      {/* Everyone: a quiet notice that the meeting is being broadcast. */}
      {!isHost && liveLine && (
        <span
          data-room-chrome="true"
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-200"
          title={remote ? `Started by ${remote.by}` : undefined}
        >
          <Radio size={14} aria-hidden className="animate-pulse" />
          {liveLine}
        </span>
      )}

      {isHost && (
        <button
          type="button"
          data-room-chrome="true"
          onClick={() => setOpen((v) => !v)}
          className={
            'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition active:scale-[0.98] ' +
            (status.live
              ? 'border-red-500 bg-red-600 text-white hover:bg-red-500'
              : planAllows
                ? 'border-red-500 bg-transparent text-red-400 hover:bg-red-500/10'
                : 'border-white/20 bg-transparent text-white/50 hover:bg-white/5')
          }
          title={
            status.live
              ? liveLine || 'Live'
              : planAllows
                ? 'Stream this meeting to YouTube, Facebook, Twitch or RTMP'
                : 'Livestreaming is on the Enterprise plan'
          }
        >
          <Radio size={16} aria-hidden className={status.live ? 'animate-pulse' : ''} />
          {status.live ? 'LIVE' : planAllows ? 'Go Live' : 'Go Live 🔒'}
        </button>
      )}

      {isHost &&
        open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => setOpen(false)}>
            <div
              ref={cardRef}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="golive-title"
              className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-3xl border border-white/10 bg-[#0b1020]/95 p-6 md:p-8 backdrop-blur-xl shadow-[0_0_80px_-20px_rgba(34,211,238,0.45)]"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={
                      'inline-flex h-2 w-2 rounded-full ' +
                      (status.live ? 'bg-rose-400 shadow-[0_0_12px_2px_rgba(244,63,94,0.8)] animate-pulse' : 'bg-white/30')
                    }
                  />
                  <h3 id="golive-title" className="text-lg font-semibold text-white">
                    {status.live ? liveLine : 'Go live'}
                  </h3>
                </div>
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white" aria-label="Close">
                  <X size={18} aria-hidden />
                </button>
              </div>

              {!planAllows && !status.live && (
                <p className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
                  Livestreaming is on the Enterprise plan. The meeting&apos;s owner can arrange it at{' '}
                  <a href="/pricing" className="underline">
                    neoconference.app/pricing
                  </a>
                  .
                </p>
              )}

              {status.live ? (
                <div className="mt-5 space-y-3">
                  <p className="text-sm text-white/70">
                    The meeting&apos;s video and audio are being sent live. Everyone in the meeting has been told.
                  </p>
                  <ul className="space-y-2">
                    {status.destinations.map((d, i) => (
                      <li key={i} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm">
                        <span className="text-white">{d.label}</span>
                        <span
                          className={
                            d.status === 'live'
                              ? 'text-emerald-300'
                              : d.status === 'failed'
                                ? 'text-rose-300'
                                : d.status === 'ended'
                                  ? 'text-white/50'
                                  : 'text-amber-200'
                          }
                          title={d.error}
                        >
                          {d.status === 'live' ? 'Live' : d.status === 'failed' ? 'Failed' + (d.error ? ': ' + d.error : '') : d.status === 'ended' ? 'Ended' : 'Connecting…'}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {status.error && <p className="text-sm text-rose-300">{status.error}</p>}
                  <button
                    type="button"
                    onClick={stop}
                    disabled={busy}
                    className="w-full rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-60"
                  >
                    {busy ? 'Stopping…' : 'Stop streaming'}
                  </button>
                </div>
              ) : (
                <div className="mt-5 space-y-4">
                  <p className="text-sm text-white/70">
                    Send this meeting live to YouTube, Facebook, Twitch or any RTMP address. Paste the stream key from the
                    platform; NeoConference does the rest, no other software needed.
                  </p>
                  {pending.map((d, i) => {
                    const platform = STREAM_PLATFORMS.find((p) => p.id === d.platform) ?? STREAM_PLATFORMS[0];
                    return (
                      <div key={i} className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3">
                        <div className="flex items-center gap-2">
                          <select
                            value={d.platform}
                            onChange={(e) => update(i, { platform: e.target.value as StreamPlatform })}
                            className={INPUT_CLASS + ' bg-[#0b1020]'}
                            aria-label="Platform"
                          >
                            {STREAM_PLATFORMS.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                          {pending.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setPending((list) => list.filter((_, j) => j !== i))}
                              className="rounded-lg p-2 text-white/50 hover:bg-white/10 hover:text-white"
                              aria-label="Remove destination"
                            >
                              <Trash2 size={16} aria-hidden />
                            </button>
                          )}
                        </div>
                        <input
                          type="password"
                          autoComplete="off"
                          value={d.key}
                          onChange={(e) => update(i, { key: e.target.value })}
                          placeholder={d.platform === 'rtmp' ? 'rtmp://…' : 'Stream key'}
                          className={INPUT_CLASS}
                          aria-label={d.platform === 'rtmp' ? 'RTMP address' : 'Stream key'}
                        />
                        <p className="text-[11px] text-white/45">{platform.keyHint}. Kept only for this stream.</p>
                        <input
                          type="text"
                          value={d.label || ''}
                          onChange={(e) => update(i, { label: e.target.value })}
                          placeholder={`Name shown to everyone (optional), e.g. "${platform.label} channel"`}
                          className={INPUT_CLASS}
                          maxLength={40}
                          aria-label="Name"
                        />
                      </div>
                    );
                  })}
                  {pending.length < 4 && (
                    <button
                      type="button"
                      onClick={() => setPending((list) => [...list, { platform: 'facebook', key: '', label: '' }])}
                      className="inline-flex items-center gap-1.5 text-sm text-cyan-300 hover:text-cyan-100"
                    >
                      <Plus size={14} aria-hidden /> Add another destination
                    </button>
                  )}
                  {error && <p className="text-sm text-rose-300">{error}</p>}
                  <button
                    type="button"
                    onClick={start}
                    disabled={busy || !planAllows}
                    className="w-full rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-60"
                  >
                    {busy ? 'Starting…' : 'Start streaming'}
                  </button>
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
