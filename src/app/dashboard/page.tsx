// src/app/dashboard/page.tsx
//
// Authenticated dashboard - lists every NeoEvent owned by the signed-in user
// with status badges, recording / transcript counts, and direct links to the
// replay page, room, and event detail pages.
//
// Server component: Clerk auth() + eventStore.listReachableByOwner.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, currentUser } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { maybeSweepMeetings } from '@/lib/meetingSweep';
import type { NeoEvent } from '@/types/event';
import UpgradeBanner from "@/components/UpgradeBanner";
import EventsGrid, { type EventCardData } from './EventsGrid';
import PersonalRoomCard from './PersonalRoomCard';
import RecurringRolesCard from './RecurringRolesCard';
import UpcomingGroupMeetings from './UpcomingGroupMeetings';
import DashboardTabs from '@/components/groups/DashboardTabs';
import { groupActor, groupCapabilities, listGroupsForUser, type GroupMember, type GroupSummary } from '@/lib/groupStore';
import { upcomingForUser } from '@/lib/groupMeetings';
import { getIdentity } from '@/lib/authz';
import DashboardGroups, { type DashboardGroup } from './DashboardGroups';

/** Partner zone meetings shown on the dashboard; the rest are counted. */
const ZONES_SHOWN = 24;

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) {
    redirect('/sign-in?redirect_url=/dashboard');
  }

  // End meetings whose room has already closed, before listing them — the
  // same throttled, never-throwing sweep /api/events/mine runs for the app.
  // Only the app ran it, so on the web a finished meeting stayed LIVE until
  // someone opened the phone.
  await maybeSweepMeetings();

  // A KV blip in groups should cost the groups, not the dashboard.
  const groupsP: Promise<GroupSummary[]> = listGroupsForUser(userId!).catch((err) => {
    console.warn('[dashboard] groups failed', err);
    return [];
  });
  const [user, events, groups, identity] = await Promise.all([
    currentUser(),
    eventStore.listReachableByOwner(userId!),
    groupsP,
    getIdentity().catch(() => null),
  ]);
  // Group meetings this person is invited to.
  const upcoming = await upcomingForUser(groups.map((g) => ({ id: g.group.id, name: g.group.name })), userId!, 8).catch((err) => {
    console.warn('[dashboard] upcoming group meetings failed', err);
    return [];
  });
  const myGroups: DashboardGroup[] = groups.map((g) => {
    const caps = groupCapabilities(
      groupActor(
        { userId: userId!, emails: identity?.emails ?? [], isPlatformAdmin: identity?.isPlatformAdmin ?? false },
        { role: g.role } as GroupMember,
      ),
    );
    return { id: g.group.id, name: g.group.name, memberCount: g.memberCount, canStart: caps.start, canCall: caps.call };
  });

  // Sort: most recently updated first. A partner website's zone meetings
  // (PrayerClouds makes one per zone, thousands, each open all the time)
  // go in their own folded section: in "Your events" they buried the
  // owner's own meetings (2026-11-13).
  const all = [...events].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const sorted = all.filter((e) => !e.partner);
  const zones = all.filter((e) => e.partner);

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
        <div className="mb-6">
          <DashboardTabs current="/dashboard" />
        </div>
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
            <Link href="/dashboard/billing" className="neo-btn-ghost text-sm px-4 py-2.5">
              Billing
            </Link>
            <Link href="/dashboard/recordings" className="neo-btn-ghost text-sm px-4 py-2.5">
              All recordings
            </Link>
            <Link href="/dashboard/groups" className="neo-btn-ghost text-sm px-4 py-2.5">
              Groups
            </Link>
            <Link href="/dashboard/reports" className="neo-btn-ghost text-sm px-4 py-2.5">
              My reports
            </Link>
            <Link href="/dashboard/new" className="neo-btn text-sm px-4 py-2.5">
              + New event
            </Link>
          </div>
        </div>

        {/* Personal room — always-live short URL the operator can hand out
            once and reuse forever. Sits above the stat strip so it's the
            first actionable thing on the dashboard. */}
        <div className="mt-8 space-y-4">
          <UpcomingGroupMeetings
            items={upcoming.map((m) => ({
              id: m.id,
              slug: m.slug,
              title: m.title,
              state: m.state,
              kind: m.kind,
              start: m.start,
              groupId: m.groupId,
              groupName: m.groupName,
            }))}
          />
          <DashboardGroups groups={myGroups} />
          <PersonalRoomCard />
          <RecurringRolesCard />
        </div>

        {/* Stat strip */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
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
            <EventsGrid events={sorted.map(toCardData)} />
          )}
        </div>

        {zones.length > 0 ? (
          <details className="mt-10 group/zones rounded-3xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
            <summary className="cursor-pointer list-none flex items-baseline justify-between gap-3">
              <span className="text-base font-semibold">
                Partner zone meetings <span className="text-white/45 font-normal tabular-nums">({zones.length.toLocaleString('en')})</span>
              </span>
              <span className="text-xs text-white/50 group-open/zones:hidden">Show</span>
              <span className="text-xs text-white/50 hidden group-open/zones:inline">Hide</span>
            </summary>
            <p className="mt-2 text-xs text-white/50">
              One meeting per zone of your partner website, always open for its visitors. Not counted in the figures above.
              {zones.length > ZONES_SHOWN ? ` Showing the ${ZONES_SHOWN} most recently active.` : ''}
            </p>
            <div className="mt-4">
              <EventsGrid events={zones.slice(0, ZONES_SHOWN).map(toCardData)} />
            </div>
          </details>
        ) : null}
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

function toCardData(ev: NeoEvent): EventCardData {
  const recordings = ev.recordings || [];
  return {
    id: ev.id,
    slug: ev.slug,
    name: ev.name,
    state: ev.state,
    updatedAt: ev.updatedAt,
    livekitRoom: ev.livekitRoom,
    recordingsCount: recordings.length,
    transcriptCount: recordings.filter((r) => r.kind === 'transcript').length,
  };
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
