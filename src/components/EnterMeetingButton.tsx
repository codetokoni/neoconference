'use client';

// EnterMeetingButton — the one way into a meeting from the dashboard and
// from a meeting's own page.
//
// It used to be two buttons on an ended meeting: "Start room →", a link
// into the room, beside "Restart event", which reopened the meeting and then
// went in. Which one to press was anyone's guess (owner, 2026-11-13). Now an
// ended meeting is reopened (POST /start, the same as "Restart event" did)
// and entered in one click; any other meeting is a plain link into the room.

import Link from 'next/link';
import { useState } from 'react';
import type { NeoEvent } from '@/types/event';

export default function EnterMeetingButton({
  eventId,
  slug,
  livekitRoom,
  state,
  className,
  label = 'Enter meeting →',
}: {
  eventId: string;
  slug: string;
  livekitRoom: string;
  state: NeoEvent['state'];
  className: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roomHref = '/room/' + encodeURIComponent(livekitRoom) + '?event=' + encodeURIComponent(slug);

  if (state !== 'ended') {
    return (
      <Link href={roomHref} className={className}>
        {label}
      </Link>
    );
  }

  async function reopenAndEnter() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/events/' + encodeURIComponent(eventId) + '/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error === 'forbidden' ? 'Only the meeting’s owner or a host can reopen it.' : 'Could not reopen the meeting. Try again.');
        setBusy(false);
        return;
      }
      // A real page load: the meeting is live again, so the short link now
      // routes into the room (see StartEventButton).
      window.location.assign('/' + encodeURIComponent(slug));
    } catch {
      setError('No connection. Try again.');
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={reopenAndEnter} disabled={busy} className={className} title="This meeting has ended. Entering opens it again.">
        {busy ? 'Opening…' : label}
      </button>
      {error ? (
        <span role="alert" className="basis-full text-xs text-rose-300">
          {error}
        </span>
      ) : null}
    </>
  );
}
