// src/app/e/[slug]/page.tsx
// Public event resolver. State machine:
//   scheduled -> countdown card
//   waiting   -> waiting room (queue + admit)
//   live      -> HLS player (if streamlab) or "join room" CTA
//   ended     -> "thanks for watching"
//   replay    -> replay player

import { eventStore } from '@/lib/eventStore';
import { toPublicView } from '@/types/event';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function EventResolverPage({
  params,
}: {
  params: { slug: string };
}) {
  const ev = await eventStore.bySlug(params.slug);
  if (!ev) return notFound();
  const v = toPublicView(ev);

  return (
    <main className="neo-event-resolver">
      <div className="neo-event-card">
        <header className="neo-event-header">
          <span className={"neo-event-state neo-event-state--" + v.state}>
            {stateLabel(v.state)}
          </span>
          <h1>{v.name}</h1>
          {v.ownerName ? (
            <p className="neo-event-host">Hosted by {v.ownerName}</p>
          ) : null}
          {v.description ? (
            <p className="neo-event-desc">{v.description}</p>
          ) : null}
        </header>

        {v.state === 'scheduled' && v.scheduledAt ? (
          <section className="neo-event-section">
            <p className="neo-event-when">
              Starts {new Date(v.scheduledAt).toLocaleString()}
            </p>
          </section>
        ) : null}

        {v.state === 'waiting' ? (
          <section className="neo-event-section">
            <p>The host is preparing to start. You\u2019ll be admitted shortly.</p>
            <Link className="neo-event-cta" href={"/room/" + ev.livekitRoom}>
              Join waiting room
            </Link>
          </section>
        ) : null}

        {v.state === 'live' ? (
          <section className="neo-event-section">
            {v.hlsUrl ? (
              <video
                className="neo-event-player"
                src={v.hlsUrl}
                controls
                autoPlay
                playsInline
              />
            ) : (
              <Link className="neo-event-cta" href={"/room/" + ev.livekitRoom}>
                Join live room
              </Link>
            )}
          </section>
        ) : null}

        {v.state === 'ended' ? (
          <section className="neo-event-section">
            <p>This event has ended. Thanks for joining.</p>
          </section>
        ) : null}

        {v.state === 'replay' && v.recordings.length > 0 ? (
          <section className="neo-event-section">
            <h2>Replay</h2>
            <ul className="neo-event-recordings">
              {v.recordings.map((r) => (
                <li key={r.key}>
                  <span>{r.label ?? r.kind}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="neo-event-footer">
          <img
            className="neo-event-qr"
            src={"/api/qr/" + ev.slug + "?size=256"}
            alt="Scan to join"
            width={128}
            height={128}
          />
          {v.shortUrl ? (
            <a className="neo-event-share" href={v.shortUrl}>
              {v.shortUrl}
            </a>
          ) : null}
        </footer>
      </div>
    </main>
  );
}

function stateLabel(s: string): string {
  switch (s) {
    case 'scheduled': return 'Scheduled';
    case 'waiting': return 'Waiting room open';
    case 'live': return 'Live now';
    case 'ended': return 'Event ended';
    case 'replay': return 'Replay available';
    default: return s;
  }
}
