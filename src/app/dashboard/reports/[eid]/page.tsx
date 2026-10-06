"use client";

// Your attendance in one group meeting: when you joined and left, how long
// you were there, your status, and who hosted. Only your own line.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";
import { attendedText as attended } from "@/lib/durationText";

interface Detail {
  title: string;
  groupName: string;
  hosts: string[];
  date: string;
  durationMin: number;
  me: {
    status: "present" | "absent";
    invited: boolean;
    declined: boolean;
    joinedAt: number | null;
    leftAt: number | null;
    attendedMs: number;
    entries: number;
    callAttempts: number;
    missedCalls: number;
  };
}

function when(ms: number | null): string {
  return ms === null ? "—" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

export default function MyMeetingPage() {
  const params = useParams<{ eid: string }>();
  const eid = params?.eid ?? "";
  const [m, setM] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/me/meetings/${encodeURIComponent(eid)}`, { cache: "no-store" });
        if (!res.ok) {
          const msg = await groupErrorFrom(res);
          if (!cancelled) setErr(msg);
          return;
        }
        const data = (await res.json()) as { meeting: Detail };
        if (!cancelled) setM(data.meeting);
      } catch {
        if (!cancelled) setErr(groupErrorMessage(null));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eid]);

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-4 border-t border-slate-800 py-2.5 first:border-t-0">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right text-slate-100">{value}</dd>
    </div>
  );

  return (
    <main className="min-h-screen bg-[#05070d] text-white">
      <div className="mx-auto max-w-xl px-4 sm:px-6 py-10 space-y-6">
        <Link href="/dashboard/reports" className="text-xs text-white/50 hover:text-white transition">← My meeting reports</Link>
        {err ? (
          <div className="text-sm text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{err}</div>
        ) : !m ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-white break-words">{m.title}</h1>
              <p className="mt-1 text-sm text-slate-300">
                {m.groupName} ·{" "}
                {new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(m.date))}
              </p>
            </div>
            <dl className="rounded-2xl border border-slate-800 bg-slate-900/40 px-4 py-1.5 text-sm">
              {row(
                "Status",
                m.me.status === "present" ? (
                  <span className="text-emerald-300"><span aria-hidden>✓ </span>Present</span>
                ) : (
                  <span className="text-amber-300"><span aria-hidden>✕ </span>{m.me.declined ? "Declined" : "Missed"}</span>
                )
              )}
              {row("Joined", when(m.me.joinedAt))}
              {row("Left", when(m.me.leftAt))}
              {row("Time attended", attended(m.me.attendedMs))}
              {m.me.entries > 1 ? row("Times you joined", m.me.entries) : null}
              {m.me.callAttempts ? row("Calls", `${m.me.callAttempts} rung · ${m.me.missedCalls} missed`) : null}
              {row("Hosted by", m.hosts.join(", "))}
              {row("Meeting length", m.durationMin ? `${m.durationMin} min` : "—")}
            </dl>
          </>
        )}
      </div>
    </main>
  );
}
