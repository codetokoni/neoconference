'use client';

// StartEventButton
// Host-only CTA shown on /e/<slug> while the event is still 'scheduled'.
// Calls POST /api/events/<id>/start to flip the event to 'live', then
// refreshes the page so the existing 'Join live room' CTA renders.

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function StartEventButton({ eventId }: { eventId: string }) {
  const router = useRouter();
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
        return;
      }
      router.refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
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
