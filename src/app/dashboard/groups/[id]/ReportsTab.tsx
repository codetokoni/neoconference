"use client";

// The group's Reports tab: finished meetings with how many were invited and
// came, a date filter, and (Host and up) a spreadsheet across the range.
// Members, who cannot see the group's reports, are pointed to their own.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";
import { minutesText as minutes } from "@/lib/durationText";

interface Item {
  eventId: string;
  title: string;
  kind: "scheduled" | "now" | "call";
  date: string;
  durationMin: number;
  invited: number;
  attended: number;
  absent: number;
}

const inputClass =
  "px-3 py-2 rounded-lg bg-slate-900 text-slate-100 border border-slate-700 focus:border-cyan-400 focus:outline-none text-sm [color-scheme:dark]";

function day(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

export default function ReportsTab({
  groupId,
  canView,
  canExport,
}: {
  groupId: string;
  canView: boolean;
  canExport: boolean;
}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const range = `${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`;
  const rangeError = from && to && to < from ? "The end date is before the start date." : null;

  const load = useCallback(async () => {
    if (!canView || rangeError) return;
    setErr(null);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/reports?${range.slice(1)}`, { cache: "no-store" });
      if (!res.ok) return setErr(await groupErrorFrom(res));
      const data = (await res.json()) as { items: Item[]; nextCursor: number | null };
      setItems(data.items);
      setCursor(data.nextCursor);
    } catch {
      setErr(groupErrorMessage(null));
    }
  }, [groupId, range, canView, rangeError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function more() {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/reports?cursor=${cursor}${range}`, { cache: "no-store" });
      if (!res.ok) return setErr(await groupErrorFrom(res));
      const data = (await res.json()) as { items: Item[]; nextCursor: number | null };
      setItems((prev) => [...(prev ?? []), ...data.items]);
      setCursor(data.nextCursor);
    } catch {
      setErr(groupErrorMessage(null));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!canView) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/20 p-10 text-center">
        <p className="font-medium text-slate-200">Your attendance is in My meeting reports</p>
        <p className="mt-1 text-sm text-slate-400">
          Group reports are for Moderators and above.{" "}
          <Link href="/dashboard/reports" className="text-cyan-300 hover:text-cyan-200">
            Open My meeting reports
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs text-slate-400">
          <span className="block">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
        </label>
        <label className="space-y-1 text-xs text-slate-400">
          <span className="block">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
        </label>
        {from || to ? (
          <button
            type="button"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
            className="px-3 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-xs"
          >
            Clear dates
          </button>
        ) : null}
        {canExport ? (
          from && to && !rangeError ? (
            <a
              href={`/api/groups/${encodeURIComponent(groupId)}/reports/export?from=${from}&to=${to}`}
              className="ml-auto px-4 py-2 rounded-full border border-cyan-400/50 text-cyan-100 hover:bg-cyan-500/15 transition text-sm"
            >
              Export range (XLSX)
            </a>
          ) : (
            <span className="ml-auto text-xs text-slate-400">Choose both dates to export a range.</span>
          )
        ) : null}
      </div>
      {rangeError ? <p className="text-xs text-rose-300">{rangeError}</p> : null}
      {err ? <div className="text-sm text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{err}</div> : null}

      {items === null ? (
        <p className="text-sm text-slate-400">Loading reports…</p>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/20 p-10 text-center">
          <p className="font-medium text-slate-200">No reports yet</p>
          <p className="mt-1 text-sm text-slate-400">A meeting&apos;s report appears here once it has ended.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-800">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-slate-900/70 text-left text-xs uppercase tracking-wider text-slate-400">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Date</th>
                <th scope="col" className="px-4 py-3 font-medium">Meeting</th>
                <th scope="col" className="px-4 py-3 font-medium">Duration</th>
                <th scope="col" className="px-4 py-3 font-medium">Attended</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.eventId} className="border-t border-slate-800 hover:bg-slate-900/50">
                  <td className="px-4 py-3 whitespace-nowrap text-slate-300">{day(i.date)}</td>
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/groups/${encodeURIComponent(groupId)}/reports/${encodeURIComponent(i.eventId)}`} className="text-slate-100 hover:text-cyan-200">
                      {i.title}
                    </Link>
                    {i.kind === "call" ? <span className="ml-2 text-xs text-slate-400">call</span> : null}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-300">{minutes(i.durationMin)}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-300">
                    {i.attended} / {i.invited}
                    {i.absent > 0 ? <span className="ml-2 text-xs text-amber-300">{i.absent} absent</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor !== null ? (
        <button type="button" onClick={more} disabled={loadingMore} className="text-xs text-cyan-300 hover:text-cyan-200 disabled:opacity-60">
          {loadingMore ? "Loading…" : "Show older meetings"}
        </button>
      ) : null}
    </div>
  );
}
