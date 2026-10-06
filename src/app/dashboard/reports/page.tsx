"use client";

// My meeting reports: every finished group meeting you were invited to or
// joined, with your own time and status — including the ones you missed,
// and meetings of groups you have since left.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";
import { attendedText as attended } from "@/lib/durationText";

interface Item {
  eventId: string;
  title: string;
  groupName: string;
  date: string;
  durationMin: number;
  attendedMs: number;
  status: "present" | "absent";
  declined: boolean;
}

function day(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

export default function MyReportsPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (next?: number) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/me/meetings${next !== undefined ? `?cursor=${next}` : ""}`, { cache: "no-store" });
      if (!res.ok) return setErr(await groupErrorFrom(res));
      const data = (await res.json()) as { items: Item[]; nextCursor: number | null };
      setItems((prev) => (next !== undefined ? [...(prev ?? []), ...data.items] : data.items));
      setCursor(data.nextCursor);
    } catch {
      setErr(groupErrorMessage(null));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="min-h-screen bg-[#05070d] text-white">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10 md:py-14 space-y-6">
        <div>
          <Link href="/dashboard" className="text-xs text-white/50 hover:text-white transition">← Dashboard</Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">My meeting reports</h1>
          <p className="mt-1.5 text-sm text-white/60">Group meetings you were invited to, and how long you were there.</p>
        </div>

        {err ? <div className="text-sm text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{err}</div> : null}

        {items === null ? (
          busy ? <p className="text-sm text-slate-400">Loading your meetings…</p> : null
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/20 p-10 text-center">
            <p className="font-medium text-slate-200">No meetings yet</p>
            <p className="mt-1 text-sm text-slate-400">Group meetings you&apos;re invited to appear here after they end.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-800">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-slate-900/70 text-left text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Meeting</th>
                  <th scope="col" className="px-4 py-3 font-medium">Date</th>
                  <th scope="col" className="px-4 py-3 font-medium">You attended</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.eventId} className="border-t border-slate-800 hover:bg-slate-900/50">
                    <td className="px-4 py-3">
                      <Link href={`/dashboard/reports/${encodeURIComponent(i.eventId)}`} className="text-slate-100 hover:text-cyan-200">
                        {i.title}
                      </Link>
                      <div className="text-xs text-slate-400">{i.groupName}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-300">{day(i.date)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-300">{attended(i.attendedMs)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {i.status === "present" ? (
                        <span className="text-emerald-300"><span aria-hidden>✓ </span>Present</span>
                      ) : (
                        <span className="text-amber-300"><span aria-hidden>✕ </span>{i.declined ? "Declined" : "Missed"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor !== null ? (
          <button type="button" onClick={() => load(cursor)} disabled={busy} className="text-xs text-cyan-300 hover:text-cyan-200 disabled:opacity-60">
            {busy ? "Loading…" : "Show older meetings"}
          </button>
        ) : null}
      </div>
    </main>
  );
}
