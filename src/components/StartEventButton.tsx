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
    <div className="neo-event-host-actions" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
      <button
        onClick={start}
        disabled={loading}
        className="neo-event-cta"
        style={{ opacity: loading ? 0.6 : 1 }}
      >
        {loading ? 'Starting…' : 'Start event now'}
      </button>
      {error && (
        <p style={{ color: '#fca5a5', fontSize: 12, margin: 0 }}>{error}</p>
      )}
    </div>
  );
}
