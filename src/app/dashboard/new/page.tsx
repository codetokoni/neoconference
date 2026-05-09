'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type CreateResult = {
  ok: boolean;
  event?: {
    id: string;
    slug: string;
    title: string;
    eventUrl: string;
    qrUrl: string;
    shortUrl?: string;
    rtmpUrl?: string;
    streamKey?: string;
    hlsUrl?: string;
  };
  error?: string;
};

export default function NewEventPage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [password, setPassword] = useState('');
  const [enableStream, setEnableStream] = useState(true);
  const [eventType, setEventType] = useState<'meeting' | 'webinar' | 'livestream'>('meeting');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch('/api/events/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: title.trim(),
          description: description.trim() || undefined,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
          password: password || undefined,
          enableStream,
          type: eventType,
        }),
      });
      const json = await res.json();
      setResult(json);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setResult({ ok: false, error: msg });
    } finally {
      setSubmitting(false);
    }
  }

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <main className="min-h-screen bg-[#05070d] text-white relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-60">
        <div className="absolute -top-40 -left-40 h-[480px] w-[480px] rounded-full bg-cyan-500/20 blur-[120px]" />
        <div className="absolute top-1/3 -right-40 h-[520px] w-[520px] rounded-full bg-indigo-500/15 blur-[140px]" />
        <div className="absolute bottom-0 left-1/3 h-[400px] w-[400px] rounded-full bg-fuchsia-500/10 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-5xl px-4 sm:px-6 py-10 md:py-20">
        <div className="mb-8 sm:mb-10 flex items-center justify-between gap-4">
          <Link href="/" className="text-xs sm:text-sm text-white/60 hover:text-white transition">
            ← Back to NeoConference
          </Link>
          <span className="text-[10px] sm:text-xs uppercase tracking-[0.3em] text-cyan-300/70">
            New Event
          </span>
        </div>

        <h1 className="text-3xl sm:text-4xl md:text-6xl font-semibold tracking-tight">
          Create your <span className="bg-gradient-to-r from-cyan-300 via-sky-300 to-indigo-300 bg-clip-text text-transparent">cinematic</span> event
        </h1>
        <p className="mt-3 sm:mt-4 max-w-2xl text-sm sm:text-base text-white/60">
          One action provisions everything: a smart link, a scannable QR, optional RTMP livestream, and an HLS replay-ready URL.
        </p>

        <form onSubmit={handleSubmit} className="mt-8 sm:mt-10 grid gap-5 sm:gap-6 rounded-3xl border border-white/10 bg-white/[0.03] p-5 sm:p-6 md:p-10 backdrop-blur-xl shadow-[0_0_60px_-20px_rgba(34,211,238,0.25)]">
          <div className="grid gap-2">
            <label className="text-xs uppercase tracking-[0.2em] text-white/50">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Sunday Service · Q3 All-Hands · Launch Stream"
              required
              className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm sm:text-base outline-none focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 transition"
            />
          </div>

          <div className="grid gap-2">
            <label className="text-xs uppercase tracking-[0.2em] text-white/50">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="What is this event about?"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm sm:text-base outline-none focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 transition resize-none"
            />
          </div>

          <div className="grid gap-5 sm:gap-6 md:grid-cols-2">
            <div className="grid gap-2">
              <label className="text-xs uppercase tracking-[0.2em] text-white/50">Scheduled at</label>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm sm:text-base outline-none focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 transition"
              />
            </div>
            <div className="grid gap-2">
              <label className="text-xs uppercase tracking-[0.2em] text-white/50">Access password (optional)</label>
              <input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank for open access"
                className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm sm:text-base outline-none focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 transition"
              />
            </div>
          </div>

          <div className="grid gap-3">
            <label className="text-xs uppercase tracking-[0.2em] text-white/50">Event type</label>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              {(['meeting', 'webinar', 'livestream'] as const).map((t) => (
                <button
                  type="button"
                  key={t}
                  onClick={() => setEventType(t)}
                  className={`rounded-xl border px-2 sm:px-4 py-3 text-xs sm:text-sm capitalize transition ${
                    eventType === t
                      ? 'border-cyan-400/70 bg-cyan-400/10 text-cyan-100 shadow-[0_0_30px_-10px_rgba(34,211,238,0.6)]'
                      : 'border-white/10 bg-black/30 text-white/70 hover:border-white/20'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-start sm:items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={enableStream}
              onChange={(e) => setEnableStream(e.target.checked)}
              className="mt-0.5 sm:mt-0 h-5 w-5 rounded border-white/20 bg-black/40 text-cyan-400 focus:ring-cyan-400/40 shrink-0"
            />
            <span className="text-xs sm:text-sm text-white/80">
              Provision RTMP livestream + HLS replay (StreamLab Cloud)
            </span>
          </label>

          <button
            type="submit"
            disabled={submitting || !title.trim()}
            className="mt-2 w-full rounded-2xl bg-gradient-to-r from-cyan-400 to-sky-500 px-6 py-3.5 sm:py-4 text-sm sm:text-base font-semibold text-black shadow-[0_0_40px_-10px_rgba(34,211,238,0.7)] transition hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Provisioning…' : 'Create event'}
          </button>
        </form>

        {result?.ok && result.event && (
          <div className="mt-8 sm:mt-10 rounded-3xl border border-cyan-400/30 bg-gradient-to-br from-cyan-500/[0.07] to-indigo-500/[0.04] p-5 sm:p-6 md:p-10 backdrop-blur-xl shadow-[0_0_80px_-20px_rgba(34,211,238,0.4)]">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_12px_2px_rgba(103,232,249,0.9)]" />
              <h2 className="text-xl sm:text-2xl font-semibold">Event ready</h2>
            </div>
            <p className="mt-2 text-white/60 text-xs sm:text-sm">
              Share these with your audience. Anyone with the link or QR can join according to your settings.
            </p>

            <div className="mt-6 sm:mt-8 grid gap-6 md:grid-cols-[1fr_auto] items-start">
              <div className="space-y-4 order-2 md:order-1">
                <Field label="Event link" value={result.event.eventUrl} onCopy={() => copy(result.event!.eventUrl, 'event')} copied={copied === 'event'} />
                {result.event.shortUrl && (
                  <Field label="Short link" value={result.event.shortUrl} onCopy={() => copy(result.event!.shortUrl!, 'short')} copied={copied === 'short'} />
                )}
                {result.event.rtmpUrl && (
                  <Field label="RTMP ingest" value={result.event.rtmpUrl} onCopy={() => copy(result.event!.rtmpUrl!, 'rtmp')} copied={copied === 'rtmp'} mono />
                )}
                {result.event.streamKey && (
                  <Field label="Stream key" value={result.event.streamKey} onCopy={() => copy(result.event!.streamKey!, 'key')} copied={copied === 'key'} mono secret />
                )}
                {result.event.hlsUrl && (
                  <Field label="HLS playback" value={result.event.hlsUrl} onCopy={() => copy(result.event!.hlsUrl!, 'hls')} copied={copied === 'hls'} mono />
                )}
              </div>
              <div className="flex flex-col items-center gap-3 order-1 md:order-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={result.event.qrUrl}
                  alt="Event QR code"
                  className="h-36 w-36 sm:h-44 sm:w-44 rounded-2xl border border-white/15 bg-white p-3"
                />
                <a
                  href={result.event.qrUrl + '?format=svg&download=1'}
                  download={`neo-${result.event.slug}.svg`}
                  className="text-xs text-cyan-200/80 hover:text-cyan-100 transition"
                >
                  Download SVG
                </a>
              </div>
            </div>

            <div className="mt-6 sm:mt-8 grid grid-cols-1 sm:flex sm:flex-wrap gap-3">
              <button
                onClick={() => router.push(`/e/${result.event!.slug}`)}
                className="w-full sm:w-auto rounded-xl bg-white text-black px-5 py-3 text-sm font-medium hover:bg-white/90 transition"
              >
                Open event page →
              </button>
              <button
                onClick={() => {
                  setResult(null); setTitle(''); setDescription(''); setPassword(''); setScheduledAt('');
                }}
                className="w-full sm:w-auto rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm text-white/80 hover:bg-white/10 transition"
              >
                Create another
              </button>
            </div>
          </div>
        )}

        {result && !result.ok && (
          <div className="mt-8 rounded-2xl border border-red-400/30 bg-red-500/10 p-5 text-sm text-red-200">
            {result.error || 'Could not create event.'}
          </div>
        )}
      </div>
    </main>
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
      <div className="text-[11px] uppercase tracking-[0.22em] text-white/45 mb-1.5">{label}</div>
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2.5">
        <code className={(mono ? 'font-mono ' : '') + 'flex-1 truncate text-xs sm:text-sm text-white/85'}>{display}</code>
        {secret && (
          <button onClick={() => setReveal((v) => !v)} className="text-[11px] text-white/50 hover:text-white/80 transition px-2">
            {reveal ? 'Hide' : 'Show'}
          </button>
        )}
        <button onClick={onCopy} className="text-[11px] text-cyan-200/80 hover:text-cyan-100 transition px-2">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
