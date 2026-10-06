"use client";

// "Upcoming" on the dashboard: group meetings the signed-in person is invited
// to, across all their groups. Times are shown in the viewer's own timezone,
// which only the browser knows.

import { useEffect, useState } from "react";
import Link from "next/link";

export interface UpcomingItem {
  id: string;
  slug: string;
  title: string;
  state: string;
  kind: "scheduled" | "now" | "call";
  start: string;
  groupId: string;
  groupName: string;
}

const JOIN_EARLY_MS = 15 * 60_000;

export default function UpcomingGroupMeetings({ items }: { items: UpcomingItem[] }) {
  // Rendered first without times (the server cannot know the viewer's zone),
  // then with them once in the browser.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (items.length === 0) return null;

  const [next, ...later] = items;
  const nextLive = next.state === "live";
  const nextJoinable = nextLive || (now !== null && Date.parse(next.start) - now <= JOIN_EARLY_MS);
  const nextHref = nextLive ? `/room/${encodeURIComponent(next.slug)}?event=${encodeURIComponent(next.slug)}` : `/${encodeURIComponent(next.slug)}`;

  return (
    <section aria-labelledby="upcoming-meetings" className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 id="upcoming-meetings" className="text-xs uppercase tracking-widest text-slate-400">Up next</h2>
      <div className={"mt-3 flex flex-wrap items-center gap-3 rounded-xl border p-4 " + (nextLive ? "border-rose-400/40 bg-rose-500/10" : "border-cyan-400/30 bg-cyan-500/5")}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium text-slate-100">{next.title}</div>
          <div className="text-sm text-slate-300">
            <Link href={`/dashboard/groups/${encodeURIComponent(next.groupId)}`} className="hover:text-white">{next.groupName}</Link>
            {" · "}
            {nextLive ? (
              <span className="text-rose-200">Live now</span>
            ) : now === null ? (
              "…"
            ) : (
              new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(next.start))
            )}
            {next.kind === "call" ? " · Private call" : ""}
          </div>
        </div>
        {nextJoinable ? (
          <a href={nextHref} className={"shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition " + (nextLive ? "bg-rose-400 text-slate-950 hover:bg-rose-300" : "bg-cyan-500 text-slate-950 hover:bg-cyan-400")}>
            Join
          </a>
        ) : null}
      </div>
      {later.length > 0 ? <h3 className="mt-4 text-xs uppercase tracking-widest text-slate-400">Later</h3> : null}
      <ul className="mt-2 grid gap-2">
        {later.map((m) => {
          const live = m.state === "live";
          const joinable = live || (now !== null && Date.parse(m.start) - now <= JOIN_EARLY_MS);
          const href = live ? `/room/${encodeURIComponent(m.slug)}?event=${encodeURIComponent(m.slug)}` : `/${encodeURIComponent(m.slug)}`;
          return (
            <li key={m.id} className="min-w-0 flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-slate-100">{m.title}</div>
                <div className="text-xs text-slate-400">
                  <Link href={`/dashboard/groups/${encodeURIComponent(m.groupId)}`} className="hover:text-slate-200">
                    {m.groupName}
                  </Link>
                  {" · "}
                  {live ? (
                    <span className="text-rose-300">Live now</span>
                  ) : now === null ? (
                    "…"
                  ) : (
                    new Intl.DateTimeFormat(undefined, {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    }).format(new Date(m.start))
                  )}
                  {m.kind === "call" ? " · Private call" : ""}
                </div>
              </div>
              {joinable ? (
                <a
                  href={href}
                  className={
                    "shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition " +
                    (live ? "bg-rose-400 text-slate-950 hover:bg-rose-300" : "bg-cyan-500 text-slate-950 hover:bg-cyan-400")
                  }
                >
                  Join
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
