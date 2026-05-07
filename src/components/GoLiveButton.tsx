'use client';

import { useState } from 'react';

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
}: {
  roomName: string;
  eventSlug?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stream, setStream] = useState<Stream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

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
      <button
        onClick={() => setOpen((v) => !v)}
        className={'inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium border transition shadow-[0_0_24px_-8px_rgba(244,63,94,0.6)] ' + (stream ? 'border-rose-400/50 bg-rose-500/15 text-rose-100' : 'border-white/15 bg-black/40 text-white/80 hover:bg-white/10')}
        title="Provision RTMP livestream for this room"
      >
        <span className={'inline-flex h-1.5 w-1.5 rounded-full ' + (stream ? 'bg-rose-400 animate-pulse' : 'bg-cyan-300')} />
        {stream ? 'LIVE' : 'Go Live'}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#0b1020]/95 p-6 md:p-8 backdrop-blur-xl shadow-[0_0_80px_-20px_rgba(34,211,238,0.45)]"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2 w-2 rounded-full bg-rose-400 shadow-[0_0_12px_2px_rgba(244,63,94,0.8)] animate-pulse" />
                <h3 className="text-lg font-semibold text-white">Livestream this room</h3>
              </div>
              <button onClick={() => setOpen(false)} className="text-white/40 hover:text-white/80 transition text-sm">Close</button>
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
              </div>
            )}
          </div>
        </div>
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
