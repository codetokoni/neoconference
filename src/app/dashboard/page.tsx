// src/app/dashboard/page.tsx
//
// Authenticated dashboard - lists every NeoEvent owned by the signed-in user
// with status badges, recording / transcript counts, and direct links to the
// replay page, room, and event detail pages.
//
// Server component: Clerk auth() + eventStore.listByOwner.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, currentUser } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import type { NeoEvent } from '@/types/event';
import UpgradeBanner from "@/components/UpgradeBanner";

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) {
    redirect('/sign-in?redirect_url=/dashboard');
  }

  const [user, events] = await Promise.all([
    currentUser(),
    eventStore.listByOwner(userId!),
  ]);

  // Sort: most recently updated first.
  const sorted = [...events].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  const totals = {
    events: sorted.length,
    live: sorted.filter((e) => e.state === 'live').length,
    replay: sorted.filter((e) => (e.recordings || []).length > 0).length,
    transcripts: sorted.reduce(
      (acc, e) => acc + (e.recordings || []).filter((r) => r.kind === 'transcript').length,
      0
    ),
  };

  const greeting = user?.firstName || user?.username || 'there';

  return (
    <main className="min-h-screen bg-[#05070d] text-white relative overflow-hidden">
        <UpgradeBanner />
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 opacity-60">
        <div className="absolute -top-40 -left-40 h-[480px] w-[480px] rounded-full bg-cyan-500/15 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[420px] w-[420px] rounded-full bg-fuchsia-500/10 blur-[120px]" />
        <div className="absolute inset-0 neo-grid-bg opacity-50" />
      </div>

      <div className="relative mx-auto max-w-6xl px-4 sm:px-6 py-10 md:py-14">
        {/* Top row */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <Link href="/" className="text-xs text-white/50 hover:text-white transition">
              ← Home
            </Link>
            <h1 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
              Welcome back, <span className="neo-gradient-text">{greeting}</span>
            </h1>
            <p className="mt-1.5 text-sm text-white/60">
              Your events, replays, and AI transcripts in one place.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/dashboard/recordings" className="neo-btn-ghost text-sm px-4 py-2.5">
              All recordings
            </Link>
            <Link href="/dashboard/new" className="neo-btn text-sm px-4 py-2.5">
              + New event
            </Link>
          </div>
        </div>

        {/* Stat strip */}
        <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Events" value={totals.events} />
          <Stat label="Live now" value={totals.live} accent="cyan" />
          <Stat label="With replay" value={totals.replay} />
          <Stat label="Transcripts" value={totals.transcripts} accent="fuchsia" />
        </div>

        {/* Events grid */}
        <div className="mt-10 sm:mt-12">
          <div className="flex items-baseline justify-between gap-3 mb-5">
            <h2 className="text-lg sm:text-xl font-semibold">Your events</h2>
            <span className="text-[10px] uppercase tracking-[0.22em] text-white/40">
              Sorted by recent activity
            </span>
          </div>

          {sorted.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {sorted.map((ev) => (
                <EventCard key={ev.id} ev={ev} />
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: 'cyan' | 'fuchsia' }) {
  const tint =
    accent === 'cyan'
      ? 'text-cyan-300 shadow-[0_0_24px_-8px_rgba(34,211,238,0.6)]'
      : accent === 'fuchsia'
      ? 'text-fuchsia-300 shadow-[0_0_24px_-8px_rgba(232,121,249,0.6)]'
      : 'text-white';
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl px-4 py-3.5">
      <div className="text-[10px] uppercase tracking-[0.22em] text-white/45">{label}</div>
      <div className={'mt-1.5 text-2xl font-semibold tabular-nums ' + tint}>{value}</div>
    </div>
  );
}

function EventCard({ ev }: { ev: NeoEvent }) {
  const recCount = (ev.recordings || []).length;
  const transcriptCount = (ev.recordings || []).filter((r) => r.kind === 'transcript').length;
  const updated = ev.updatedAt ? new Date(ev.updatedAt).toLocaleDateString() : '';

  // Deterministic gradient seed from slug for thumbnail variety.
  const seed = ev.slug.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 4;
  const gradients = [
    'from-cyan-500/30 via-sky-500/15 to-indigo-500/20',
    'from-fuchsia-500/25 via-pink-500/15 to-rose-500/20',
    'from-emerald-500/25 via-teal-500/15 to-cyan-500/20',
    'from-amber-500/20 via-orange-500/15 to-rose-500/20',
  ];
  const gradient = gradients[seed];

  return (
    <div className="group relative rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl overflow-hidden hover:border-cyan-300/30 transition">
      {/* Thumbnail */}
      <div className={'relative h-28 sm:h-32 bg-gradient-to-br ' + gradient + ' overflow-hidden'}>
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.08),transparent_60%)]" />
        <StateBadge state={ev.state} />
        {recCount > 0 && (
          <span className="absolute bottom-2.5 right-2.5 rounded-full bg-black/55 backdrop-blur px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-white/85">
            {recCount} clip{recCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="p-4 sm:p-5">
        <h3 className="text-base font-semibold text-white truncate" title={ev.name}>{ev.name}</h3>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-white/45 uppercase tracking-[0.18em]">
          <span className="truncate">/e/{ev.slug}</span>
          {updated && (<><span>·</span><span>{updated}</span></>)}
        </div>

        {transcriptCount > 0 && (
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-fuchsia-500/10 border border-fuchsia-300/20 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.2em] text-fuchsia-200">
            <span className="h-1 w-1 rounded-full bg-fuchsia-300" /> {transcriptCount} transcript{transcriptCount === 1 ? '' : 's'}
          </div>
        )}

        <div className="mt-4 flex items-center gap-2 text-xs">
          <Link href={'/dashboard/e/' + ev.slug} className="flex-1 text-center rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 hover:bg-white/[0.08] transition">
            Manage
          </Link>
          <Link href={'/e/' + ev.slug + '/replay'} className="flex-1 text-center rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 hover:bg-white/[0.08] transition">
            Replay
          </Link>
          <Link href={'/room/' + ev.livekitRoom + '?event=' + ev.slug} className="flex-1 text-center rounded-lg border border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-100 px-3 py-2 hover:bg-cyan-300/[0.14] transition">
            Open room →
          </Link>
        </div>
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: NeoEvent['state'] }) {
  const cfg: Record<NeoEvent['state'], { label: string; cls: string }> = {
    scheduled: { label: 'Scheduled', cls: 'bg-white/10 text-white/85' },
    waiting: { label: 'Waiting', cls: 'bg-amber-500/20 text-amber-100 border border-amber-300/25' },
    live: { label: 'Live', cls: 'bg-rose-500/20 text-rose-100 border border-rose-300/30 animate-pulse' },
    ended: { label: 'Ended', cls: 'bg-white/10 text-white/65' },
    replay: { label: 'Replay', cls: 'bg-cyan-500/15 text-cyan-100 border border-cyan-300/25' },
    archived: { label: 'Archived', cls: 'bg-white/5 text-white/40' },
  };
  const c = cfg[state] || cfg.scheduled;
  return (
    <span className={'absolute top-2.5 left-2.5 rounded-full backdrop-blur px-2.5 py-0.5 text-[10px] uppercase tracking-[0.2em] ' + c.cls}>
      {c.label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-10 sm:p-14 text-center">
      <div className="text-3xl text-white/30">…</div>
      <h3 className="mt-3 text-lg font-semibold">No events yet</h3>
      <p className="mt-1.5 text-sm text-white/55">
        Spin one up to get a QR code, replay page, and AI transcripts.
      </p>
      <div className="mt-5">
        <Link href="/dashboard/new" className="neo-btn text-sm px-5 py-2.5 inline-block">
          Create your first event
        </Link>
      </div>
    </div>
  );
}
