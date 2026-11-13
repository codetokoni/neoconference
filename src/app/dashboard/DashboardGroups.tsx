'use client';

// "Your groups" on the dashboard: each group with Start meeting (a meeting
// for the whole group now; everyone is rung) and Call (pick who to ring),
// so neither needs a trip through the Groups page first. Start meeting does
// what the group page's button does; Call opens the group page with its
// picker already open. Buttons show only for ranks that may use them (the
// routes check again).

import Link from 'next/link';
import { useState } from 'react';
import { groupErrorFrom, groupErrorMessage } from '@/lib/groupMessages';

export interface DashboardGroup {
  id: string;
  name: string;
  memberCount: number;
  canStart: boolean;
  canCall: boolean;
}

/** The group page with its "Private call" picker open. */
export const callHref = (id: string) => `/dashboard/groups/${encodeURIComponent(id)}?call=1`;

export default function DashboardGroups({ groups }: { groups: DashboardGroup[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ id: string; text: string } | null>(null);
  if (groups.length === 0) return null;

  async function startMeeting(g: DashboardGroup) {
    setBusy(g.id);
    setErr(null);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(g.id)}/meetings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'now',
          title: `${g.name} meeting`,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
      });
      if (!res.ok) {
        setErr({ id: g.id, text: await groupErrorFrom(res) });
        setBusy(null);
        return;
      }
      const { slug } = (await res.json()) as { slug: string };
      window.location.assign(`/room/${encodeURIComponent(slug)}?event=${encodeURIComponent(slug)}`);
    } catch {
      setErr({ id: g.id, text: groupErrorMessage(null) });
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="your-groups" className="rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 id="your-groups" className="text-base font-semibold">
          Your groups
        </h2>
        <Link href="/dashboard/groups" className="text-xs text-white/50 hover:text-cyan-200 transition">
          All groups →
        </Link>
      </div>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {groups.map((g) => (
          <li key={g.id} className="min-w-0 rounded-2xl border border-white/10 bg-black/20 px-3.5 py-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <Link href={`/dashboard/groups/${encodeURIComponent(g.id)}`} className="min-w-0 flex-1 basis-40 hover:text-cyan-200 transition">
                <span className="block truncate text-sm font-medium">{g.name}</span>
                <span className="block text-[11px] text-white/45">
                  {g.memberCount} member{g.memberCount === 1 ? '' : 's'}
                </span>
              </Link>
              <div className="flex shrink-0 gap-1.5">
                {g.canStart ? (
                  <button
                    type="button"
                    onClick={() => startMeeting(g)}
                    disabled={busy !== null}
                    aria-label={`Start a meeting for ${g.name}`}
                    title="Starts a meeting now and rings every member"
                    className="rounded-full bg-cyan-500 px-3 py-1.5 text-xs font-medium text-slate-950 hover:bg-cyan-400 transition disabled:opacity-60"
                  >
                    {busy === g.id ? 'Starting…' : 'Start meeting'}
                  </button>
                ) : null}
                {g.canCall ? (
                  <Link
                    href={callHref(g.id)}
                    aria-label={`Call people in ${g.name}`}
                    title="Choose who to ring"
                    className="rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/85 hover:border-cyan-300/50 hover:text-cyan-100 transition"
                  >
                    Call
                  </Link>
                ) : null}
              </div>
            </div>
            {err?.id === g.id ? (
              <p role="alert" className="text-xs text-rose-300">
                {err.text}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
