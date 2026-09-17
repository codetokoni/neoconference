'use client';

// StartEventButton
// Host-only CTA shown on /e/<slug> while the event is still 'scheduled'.
// On click: POST /api/events/<id>/start to flip the event to 'live', then
// route the host straight into the room with ?event=<slug> so they're
// recognized as host (skip the extra 'Join live room' step).

import { useState } from 'react';

export default function StartEventButton({
  eventId,
  slug,
}: {
  eventId: string;
  slug: string;
  /** Kept in the prop shape for older callers, but no longer read —
   *  navigation now goes through the short URL so middleware picks the
   *  room to rewrite into. */
  livekitRoom?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/events/' + encodeURIComponent(eventId) + '/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || 'Could not start the event.');
        setLoading(false);
        return;
      }
      // Full-page navigation to the short URL. router.push('/<slug>')
      // is a no-op in App Router when the browser bar already shows
      // the same path (we live at `neoconference.app/<slug>` thanks to
      // the middleware rewrite), which is what stranded the "Starting…"
      // label on scree with no state change. A real navigation
      // guarantees the button unmounts and gives middleware a fresh
      // request in which to re-read the event's now-live state and
      // rewrite to /room/. Address bar stays on /<slug>.
      window.location.assign('/' + encodeURIComponent(slug));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Network error');
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={start}
        disabled={loading}
        className="inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-cyan-400 to-sky-500 px-5 py-2.5 text-sm font-semibold text-slate-900 shadow-[0_0_30px_-8px_rgba(34,211,238,0.6)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-slate-900/70 animate-pulse" />
            Starting…
          </>
        ) : (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500 shadow-[0_0_8px_2px_rgba(244,63,94,0.6)]" />
            Start now
          </>
        )}
      </button>
      {error ? (
        <p className="text-xs text-rose-300">{error}</p>
      ) : null}
    </div>
  );
}
