// src/app/e/[slug]/page.tsx
// Public event landing. State machine:
//   scheduled -> countdown card + (host) Start now
//   waiting   -> waiting room (queue + admit)
//   live      -> HLS player (if streamlab) or "Join live room" CTA
//   ended     -> "thanks for watching"
//   replay    -> replay player
//
// Styled with Tailwind to match the rest of the app (deep glass card on
// gradient backdrop). The previous version used .neo-event-* class names
// that had no matching CSS, leaving the page entirely unstyled.

import { eventStore } from '@/lib/eventStore';
import { toPublicView } from '@/types/event';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import TicketsList from './TicketsList';
import { auth } from '@clerk/nextjs/server';
import StartEventButton from '@/components/StartEventButton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function EventResolverPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { ticket?: string };
}) {
  const ev = await eventStore.bySlug(params.slug);
  if (!ev) return notFound();
  const { userId } = await auth();
  const isOwner = !!userId && userId === ev.ownerUserId;
  const v = toPublicView(ev);

  const statePill = stateMeta(v.state);

  return (
    <main className="min-h-[calc(100vh-64px)] w-full bg-[radial-gradient(ellipse_at_top,_rgba(34,211,238,0.08),_transparent_55%),radial-gradient(ellipse_at_bottom,_rgba(168,85,247,0.06),_transparent_60%)] px-4 py-10 md:py-16">
      <div className="mx-auto w-full max-w-2xl rounded-3xl border border-white/10 bg-[#0b1020]/80 p-6 sm:p-10 backdrop-blur-xl shadow-[0_0_80px_-30px_rgba(34,211,238,0.45)]">

        {/* ---------- Header ---------- */}
        <header className="flex flex-col items-start gap-3">
          <span className={'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] ' + statePill.cls}>
            <span className={'h-1.5 w-1.5 rounded-full ' + statePill.dot} />
            {statePill.label}
          </span>
          <h1 className="text-3xl sm:text-4xl font-semibold text-white tracking-tight">{v.name}</h1>
          {v.ownerName ? (
            <p className="text-sm text-white/55">Hosted by <span className="text-white/85">{v.ownerName}</span></p>
          ) : null}
          {v.description ? (
            <p className="mt-2 text-sm leading-relaxed text-white/70 whitespace-pre-line">{v.description}</p>
          ) : null}
        </header>

        {/* ---------- Scheduled ---------- */}
        {v.state === 'scheduled' && v.scheduledAt ? (
          <section className="mt-7 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/45">Starts</div>
            <div className="mt-1 text-lg text-white/90">
              {new Date(v.scheduledAt).toLocaleString(undefined, {
                weekday: 'short', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit',
              })}
            </div>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
              <a
                className="inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-white/5 px-5 py-2.5 text-sm font-medium text-white/85 transition hover:bg-white/10"
                href={`/api/events/${ev.slug}/ics`}
                download
              >
                Add to calendar
              </a>
              {isOwner ? <StartEventButton eventId={ev.id} slug={ev.slug} livekitRoom={ev.livekitRoom} /> : null}
            </div>
            {isOwner ? (
              <p className="mt-3 text-[11px] text-white/40">
                You’re the host. Tap <span className="text-cyan-200/80">Start now</span> to open the room immediately.
              </p>
            ) : null}
          </section>
        ) : null}

        {/* ---------- Waiting room ---------- */}
        {v.state === 'waiting' ? (
          <section className="mt-7 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <p className="text-sm text-white/75">The host is preparing to start. You’ll be admitted shortly.</p>
            <Link
              className="mt-4 inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-cyan-400 to-sky-500 px-6 py-3 text-sm font-semibold text-slate-900 shadow-[0_0_30px_-8px_rgba(34,211,238,0.6)] transition hover:brightness-110"
              href={'/room/' + ev.livekitRoom + '?event=' + ev.slug}
            >
              Join waiting room →
            </Link>
          </section>
        ) : null}

        {/* ---------- Live ---------- */}
        {v.state === 'live' ? (
          <section className="mt-7 rounded-2xl border border-rose-300/20 bg-rose-500/[0.06] p-5">
            {v.hlsUrl ? (
              <video
                className="w-full rounded-xl border border-white/10"
                src={v.hlsUrl}
                controls
                autoPlay
                playsInline
              />
            ) : (
              <>
                <p className="text-sm text-white/75">The room is open. Join when you’re ready.</p>
                <Link
                  className="mt-4 inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-cyan-400 to-sky-500 px-6 py-3 text-sm font-semibold text-slate-900 shadow-[0_0_30px_-8px_rgba(34,211,238,0.6)] transition hover:brightness-110"
                  href={'/room/' + ev.livekitRoom + '?event=' + ev.slug}
                >
                  Join live room →
                </Link>
              </>
            )}
          </section>
        ) : null}

        {/* ---------- Ended ---------- */}
        {v.state === 'ended' ? (
          <section className="mt-7 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <p className="text-sm text-white/75">This event has ended. Thanks for joining.</p>
          </section>
        ) : null}

        {/* ---------- Replay ---------- */}
        {v.state === 'replay' && v.recordings.length > 0 ? (
          <section className="mt-7 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="text-sm font-semibold text-white/85 uppercase tracking-[0.18em]">Replay</h2>
            <ul className="mt-3 space-y-1 text-sm text-white/70">
              {v.recordings.map((r) => (
                <li key={r.key}>{r.label ?? r.kind}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ---------- Ticket success flash ---------- */}
        {searchParams?.ticket === 'success' ? (
          <div className="mt-5 rounded-2xl border border-emerald-300/30 bg-emerald-400/10 p-4">
            <p className="text-sm text-emerald-200">
              Payment confirmed. You’re on the list — join when the host opens the room.
            </p>
          </div>
        ) : null}

        {/* ---------- Tickets ---------- */}
        {v.tickets && v.tickets.length > 0 && v.state !== 'ended' && v.state !== 'replay' ? (
          <div className="mt-7">
            <TicketsList eventId={ev.id} tickets={v.tickets} />
          </div>
        ) : null}

        {/* ---------- Footer: QR + share link ---------- */}
        <footer className="mt-10 flex flex-col items-center gap-4 border-t border-white/10 pt-6 sm:flex-row sm:justify-between">
          <img
            className="rounded-xl border border-white/10 bg-white p-1"
            src={'/api/qr/' + ev.slug + '?size=256'}
            alt="Scan to join"
            width={104}
            height={104}
          />
          {v.shortUrl ? (
            <a
              className="break-all text-center text-xs text-cyan-200/80 transition hover:text-cyan-100 sm:text-right"
              href={v.shortUrl}
            >
              {v.shortUrl}
            </a>
          ) : null}
        </footer>
      </div>
    </main>
  );
}

function stateMeta(s: string): { label: string; cls: string; dot: string } {
  switch (s) {
    case 'scheduled':
      return { label: 'Scheduled', cls: 'border-cyan-300/30 bg-cyan-400/10 text-cyan-200', dot: 'bg-cyan-300' };
    case 'waiting':
      return { label: 'Waiting room open', cls: 'border-amber-300/30 bg-amber-400/10 text-amber-200', dot: 'bg-amber-300 animate-pulse' };
    case 'live':
      return { label: 'Live now', cls: 'border-rose-300/30 bg-rose-500/15 text-rose-100', dot: 'bg-rose-400 animate-pulse' };
    case 'ended':
      return { label: 'Event ended', cls: 'border-white/15 bg-white/5 text-white/60', dot: 'bg-white/40' };
    case 'replay':
      return { label: 'Replay available', cls: 'border-violet-300/30 bg-violet-400/10 text-violet-200', dot: 'bg-violet-300' };
    default:
      return { label: s, cls: 'border-white/15 bg-white/5 text-white/70', dot: 'bg-white/40' };
  }
}
