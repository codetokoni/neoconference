'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Radio, X } from 'lucide-react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { RoomEvent, type Participant } from 'livekit-client';

type Stream = {
  id: string;
  rtmpUrl?: string;
  streamKey?: string;
  hlsUrl?: string;
  playbackId?: string;
};

type Resp = { ok: boolean; stream?: Stream; error?: string };

/**
 * GoLiveButton
 *
 * Floating in-room control. On click, calls /api/golive to provision a
 * StreamLab broadcast and reveals RTMP credentials + HLS URL in a glass
 * card so the host can route OBS/encoder to the broadcast.
 *
 * If the room was launched from a NeoEvent, pass eventSlug so the broadcast
 * is persisted to KV and the event auto-flips to LIVE on first ingest.
 */
export default function GoLiveButton({
  roomName,
  eventSlug,
  roomRole,
}: {
  roomName: string;
  eventSlug?: string;
  roomRole?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stream, setStream] = useState<Stream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // FRS §2: multi-destination fan-out. StreamLab's addDestination primitive
  // is wired via /api/golive/destination; UI state lives here.
  const [destPlatform, setDestPlatform] = useState<'rtmp' | 'youtube' | 'facebook' | 'twitch'>('rtmp');
  const [destUrl, setDestUrl] = useState('');
  const [destKey, setDestKey] = useState('');
  const [destLabel, setDestLabel] = useState('');
  const [destBusy, setDestBusy] = useState(false);
  const [addedDests, setAddedDests] = useState<Array<{ platform: string; label?: string }>>([]);

  // Receive-side: another host started/stopped a broadcast for this room.
  const [remoteBroadcast, setRemoteBroadcast] = useState<{ by: string } | null>(null);
  const [showStartFlash, setShowStartFlash] = useState(false);
  const wasBroadcastingRef = useRef(false);

  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();

  const isHost = roomRole === 'host';
  const isBroadcasting = !!stream || !!remoteBroadcast;

  // Subscribe to golive state messages from other participants.
  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array, participant?: Participant) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg?.type === 'golive') {
          if (msg.active) {
            setRemoteBroadcast({
              by: msg.by || participant?.name || participant?.identity || 'Someone',
            });
          } else {
            setRemoteBroadcast(null);
          }
        }
      } catch {
        // ignore non-JSON
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  // Brief "Live started" flash for non-hosts on the false→true edge.
  useEffect(() => {
    const was = wasBroadcastingRef.current;
    wasBroadcastingRef.current = isBroadcasting;
    if (!isHost && isBroadcasting && !was) {
      setShowStartFlash(true);
      const t = setTimeout(() => setShowStartFlash(false), 2500);
      return () => clearTimeout(t);
    }
  }, [isBroadcasting, isHost]);

  const broadcastState = useCallback(
    async (active: boolean) => {
      try {
        const me = localParticipant?.name || localParticipant?.identity || 'Someone';
        const payload = new TextEncoder().encode(
          JSON.stringify({ type: 'golive', active, by: me })
        );
        await localParticipant.publishData(payload, { reliable: true });
      } catch (e) {
        console.error('publishData golive failed', e);
      }
    },
    [localParticipant]
  );

  // Close panel on Escape key
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const cardRef = useRef<HTMLDivElement>(null);

  // Reset scroll to top when modal opens or stream content changes
  useEffect(() => {
    if (open && cardRef.current) {
      cardRef.current.scrollTop = 0;
    }
  }, [open, stream]);

  async function start() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/golive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomName, title: roomName, eventSlug }),
      });
      const j: Resp = await res.json();
      if (!j.ok || !j.stream) {
        setError(j.error || 'Could not start broadcast.');
      } else {
        setStream(j.stream);
        broadcastState(true);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <>
      {/* Host: persistent LIVE pill (offset below REC so both can co-exist). */}
      {isHost && isBroadcasting && (
        <div
          data-room-chrome="true"
          style={{
            position: 'absolute',
            top: 40,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 999,
            background: 'rgba(244, 63, 94, 0.95)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 0.5,
            boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
          }}
        >
          <Radio size={12} aria-hidden />
          LIVE
          {remoteBroadcast?.by && !stream ? (
            <span style={{ fontWeight: 400, opacity: 0.9 }}>· {remoteBroadcast.by}</span>
          ) : null}
        </div>
      )}

      {/* Non-host: brief "Live started" flash on the false→true edge. */}
      {!isHost && isBroadcasting && (
        <div
          data-room-chrome="true"
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            top: 80,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 14px',
            borderRadius: 999,
            background: 'rgba(17,17,24,0.85)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            border: '1px solid rgba(244,63,94,0.4)',
            color: 'rgb(253,164,175)',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: 0.3,
            boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
            pointerEvents: 'none',
            opacity: showStartFlash ? 1 : 0,
            transition: showStartFlash ? 'opacity 200ms ease-out' : 'opacity 300ms ease-in',
          }}
        >
          <Radio size={12} aria-hidden />
          Broadcast started
        </div>
      )}

      {/* Non-host: persistent discreet rose dot for continuous notice. */}
      {!isHost && isBroadcasting && (
        <div
          data-room-chrome="true"
          aria-label="Broadcast in progress"
          title="Broadcast in progress"
          style={{
            position: 'absolute',
            top: 14,
            left: 14,
            zIndex: 11,
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: '#f43f5e',
            boxShadow: '0 0 6px rgba(244,63,94,0.7)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Sender UI — owner+host only per FRS §2. */}
      {isHost && (
        <button
          type="button"
          data-room-chrome="true"
          onClick={() => setOpen((v) => !v)}
          className={
            'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition active:scale-[0.98] ' +
            (stream
              ? 'border-red-500 bg-red-600 text-white hover:bg-red-500'
              : 'border-red-500 bg-transparent text-red-400 hover:bg-red-500/10')
          }
          title="Provision RTMP livestream for this room"
        >
          <Radio size={16} aria-hidden className={stream ? 'animate-pulse' : ''} />
          {stream ? 'LIVE' : 'Go Live'}
        </button>
      )}

      {isHost && open && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
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
                <span className="inline-flex h-2 w-2 rounded-full bg-rose-400 shadow-[0_0_12px_2px_rgba(244,63,94,0.8)] animate-pulse" />
                <h3 id="golive-title" className="text-lg font-semibold text-white">Livestream this room</h3>
              </div>
              <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close dialog"
              className="rounded-full p-1.5 text-white/50 hover:text-white hover:bg-white/10 transition"
            >
              <X size={18} aria-hidden />
            </button>
            </div>

            {eventSlug && (
              <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-cyan-300/30 bg-cyan-400/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-cyan-200">
                <span className="h-1 w-1 rounded-full bg-cyan-300" />
                Linked to event · {eventSlug}
              </div>
            )}

            {!stream && (
              <>
                <p className="mt-3 text-sm text-white/60">
                  Provision an RTMP ingest + HLS playback for <span className="text-cyan-200">{roomName}</span>. Point OBS or your encoder at the credentials below — viewers can watch the HLS link from anywhere.
                </p>
                {error && (
                  <div className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-xs text-red-200">{error}</div>
                )}
                <button
                  onClick={start}
                  disabled={loading}
                  className="mt-5 w-full rounded-2xl bg-gradient-to-r from-rose-500 to-fuchsia-500 px-5 py-3 text-sm font-semibold text-white shadow-[0_0_30px_-10px_rgba(244,63,94,0.8)] transition hover:brightness-110 disabled:opacity-60"
                >
                  {loading ? 'Provisioning…' : 'Start broadcast'}
                </button>
              </>
            )}

            {stream && (
              <div className="mt-5 space-y-3">
                {stream.rtmpUrl && (
                  <Field label="RTMP ingest" value={stream.rtmpUrl} onCopy={() => copy(stream.rtmpUrl!, 'rtmp')} copied={copied === 'rtmp'} mono />
                )}
                {stream.streamKey && (
                  <Field label="Stream key" value={stream.streamKey} onCopy={() => copy(stream.streamKey!, 'key')} copied={copied === 'key'} mono secret />
                )}
                {stream.hlsUrl && (
                  <Field label="HLS playback (share with viewers)" value={stream.hlsUrl} onCopy={() => copy(stream.hlsUrl!, 'hls')} copied={copied === 'hls'} mono />
                )}
                <p className="text-[11px] text-white/45 leading-relaxed pt-2">
                  Open OBS → Settings → Stream. Service: <span className="text-white/70">Custom</span>. Server: paste RTMP ingest. Stream key: paste stream key. Hit &quot;Start streaming&quot;.
                </p>

                {/* FRS §2 destination selection — fan the same broadcast out
                    to YouTube Live, Facebook Live, Twitch, or a custom RTMP
                    endpoint alongside the primary StreamLab ingest. */}
                <div className="mt-3 rounded-xl border border-white/10 bg-black/40 p-3 space-y-2">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-white/45">Fan out to another destination</div>
                  <select
                    value={destPlatform}
                    onChange={(e) => setDestPlatform(e.target.value as 'rtmp' | 'youtube' | 'facebook' | 'twitch')}
                    className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-1.5 text-xs text-white/85 focus:outline-none focus:border-cyan-400/50"
                  >
                    <option value="rtmp">Custom RTMP</option>
                    <option value="youtube">YouTube Live</option>
                    <option value="facebook">Facebook Live</option>
                    <option value="twitch">Twitch</option>
                  </select>
                  {destPlatform === 'rtmp' && (
                    <input
                      value={destUrl}
                      onChange={(e) => setDestUrl(e.target.value)}
                      placeholder="rtmp://ingest.example.com/live"
                      className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-1.5 text-xs font-mono text-white/85 focus:outline-none focus:border-cyan-400/50"
                    />
                  )}
                  <input
                    value={destKey}
                    onChange={(e) => setDestKey(e.target.value)}
                    type="password"
                    autoComplete="off"
                    placeholder={destPlatform === 'rtmp' ? 'Stream key' : 'Stream key (from destination provider)'}
                    className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-1.5 text-xs font-mono text-white/85 focus:outline-none focus:border-cyan-400/50"
                  />
                  <input
                    value={destLabel}
                    onChange={(e) => setDestLabel(e.target.value)}
                    placeholder="Label (optional)"
                    className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-1.5 text-xs text-white/85 focus:outline-none focus:border-cyan-400/50"
                  />
                  <button
                    type="button"
                    disabled={destBusy || (destPlatform === 'rtmp' && (!destUrl.trim() || !destKey.trim())) || (destPlatform !== 'rtmp' && !destKey.trim())}
                    onClick={async () => {
                      setDestBusy(true);
                      setError(null);
                      try {
                        const res = await fetch('/api/golive/destination', {
                          method: 'POST',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({
                            eventSlug: eventSlug || roomName,
                            destination: {
                              platform: destPlatform,
                              rtmp_url: destUrl.trim() || undefined,
                              stream_key: destKey.trim() || undefined,
                              label: destLabel.trim() || undefined,
                            },
                          }),
                        });
                        const j = await res.json().catch(() => ({}));
                        if (!j.ok) {
                          setError(j.error || 'Could not add destination.');
                          return;
                        }
                        setAddedDests((prev) => [...prev, { platform: destPlatform, label: destLabel.trim() || undefined }]);
                        setDestUrl('');
                        setDestKey('');
                        setDestLabel('');
                      } catch (e: unknown) {
                        setError(e instanceof Error ? e.message : 'Network error');
                      } finally {
                        setDestBusy(false);
                      }
                    }}
                    className="w-full rounded-lg bg-cyan-500/20 border border-cyan-400/40 px-3 py-1.5 text-xs font-medium text-cyan-100 hover:bg-cyan-500/30 transition disabled:opacity-60"
                  >
                    {destBusy ? 'Adding…' : 'Add destination'}
                  </button>
                  {addedDests.length > 0 && (
                    <ul className="pt-1 space-y-0.5">
                      {addedDests.map((d, i) => (
                        <li key={i} className="text-[11px] text-emerald-300/85">
                          + {d.label ? `${d.label} · ` : ''}{d.platform}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

              <button
                type="button"
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  setError(null);
                  try {
                    const res = await fetch('/api/golive/stop', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ eventSlug: eventSlug || roomName, roomName }),
                    });
                    const j = await res.json().catch(() => ({}));
                    if (!j.ok) {
                      setError(j.error || 'Could not end broadcast.');
                      return;
                    }
                    setStream(null);
                    setOpen(false);
                    broadcastState(false);
                  } catch (e: unknown) {
                    setError(e instanceof Error ? e.message : 'Network error');
                  } finally {
                    setLoading(false);
                  }
                }}
                className="mt-3 w-full rounded-2xl border border-red-500/40 bg-red-500/10 px-5 py-3 text-sm font-semibold text-red-200 hover:bg-red-500/20 transition disabled:opacity-60"
              >
                {loading ? 'Ending…' : 'End broadcast'}
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

function Field({
  label,
  value,
  onCopy,
  copied,
  mono,
  secret,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
  mono?: boolean;
  secret?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  const display = secret && !reveal ? '\u2022'.repeat(Math.min(value.length, 28)) : value;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.22em] text-white/45 mb-1">{label}</div>
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2">
        <code className={(mono ? 'font-mono ' : '') + 'flex-1 truncate text-xs text-white/85'}>{display}</code>
        {secret && (
          <button onClick={() => setReveal((v) => !v)} className="text-[10px] text-white/50 hover:text-white/80 transition px-2">
            {reveal ? 'Hide' : 'Show'}
          </button>
        )}
        <button onClick={onCopy} className="text-[10px] text-cyan-200/80 hover:text-cyan-100 transition px-2">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
