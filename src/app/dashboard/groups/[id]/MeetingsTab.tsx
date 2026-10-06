"use client";

// The group's meetings: what is live and coming up, and what has happened.

import { useCallback, useEffect, useRef, useState } from "react";
import { useModal } from "@/components/ui/useModal";
import type { MeetingListItem } from "@/lib/groupMeetings";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";
import ScheduleDialog, { deliveryText } from "./ScheduleDialog";
import { roomHref } from "./GroupActions";

/** How early the Join button appears before a meeting starts. */
const JOIN_EARLY_MS = 15 * 60_000;

function when(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function duration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export default function MeetingsTab({
  groupId,
  groupName,
  canSchedule,
  canViewReports,
  version,
  onChanged,
}: {
  groupId: string;
  groupName: string;
  canSchedule: boolean;
  /** Past meetings link to their reports (Moderator and up). */
  canViewReports: boolean;
  /** Bumped whenever a meeting is created elsewhere on the page. */
  version: number;
  onChanged: (message: string) => void;
}) {
  const [upcoming, setUpcoming] = useState<MeetingListItem[] | null>(null);
  const [past, setPast] = useState<MeetingListItem[]>([]);
  const [pastCursor, setPastCursor] = useState<number | null>(null);
  const [pastLoaded, setPastLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<MeetingListItem | null>(null);
  const [cancelling, setCancelling] = useState<MeetingListItem | null>(null);
  const [cancelScope, setCancelScope] = useState<"this" | "following">("this");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const cancelBoxRef = useRef<HTMLDivElement>(null);
  useModal(cancelBoxRef, () => setCancelling(null), { open: cancelling !== null, busy: cancelBusy });

  const base = `/api/groups/${encodeURIComponent(groupId)}/meetings`;

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [u, p] = await Promise.all([
        fetch(`${base}?scope=upcoming`, { cache: "no-store" }),
        fetch(`${base}?scope=past`, { cache: "no-store" }),
      ]);
      if (!u.ok) return setErr(await groupErrorFrom(u));
      if (!p.ok) return setErr(await groupErrorFrom(p));
      const up = (await u.json()) as { items: MeetingListItem[] };
      const pa = (await p.json()) as { items: MeetingListItem[]; nextCursor: number | null };
      setUpcoming(up.items);
      setPast(pa.items);
      setPastCursor(pa.nextCursor);
      setPastLoaded(true);
    } catch {
      setErr(groupErrorMessage(null));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // The Join button appears 15 minutes ahead; keep "now" moving so it does.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  async function loadMore() {
    if (pastCursor === null) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`${base}?scope=past&cursor=${pastCursor}`, { cache: "no-store" });
      if (!res.ok) return setErr(await groupErrorFrom(res));
      const data = (await res.json()) as { items: MeetingListItem[]; nextCursor: number | null };
      setPast((prev) => [...prev, ...data.items]);
      setPastCursor(data.nextCursor);
    } catch {
      setErr(groupErrorMessage(null));
    } finally {
      setLoadingMore(false);
    }
  }

  async function confirmCancel() {
    if (!cancelling) return;
    setCancelBusy(true);
    setCancelErr(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(cancelling.id)}?scope=${cancelScope}`, { method: "DELETE" });
      if (!res.ok) {
        setCancelErr(await groupErrorFrom(res));
        return;
      }
      const data = (await res.json()) as { cancelled: string[]; notified: { sent: number; unreachable: number } };
      setCancelling(null);
      onChanged(
        [`Cancelled ${data.cancelled.length} ${data.cancelled.length === 1 ? "meeting" : "meetings"}.`, deliveryText(data.notified)]
          .filter(Boolean)
          .join(" ")
      );
    } catch {
      setCancelErr(groupErrorMessage(null));
    } finally {
      setCancelBusy(false);
    }
  }

  if (err && upcoming === null) {
    return <div className="text-sm text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{err}</div>;
  }
  if (upcoming === null) return <p className="text-sm text-slate-400">Loading meetings…</p>;

  const live = upcoming.filter((m) => m.state === "live");
  const later = upcoming.filter((m) => m.state !== "live");

  return (
    <div className="space-y-8">
      {live.map((m) => (
        <a
          key={m.id}
          href={roomHref(m.slug)}
          className="flex items-center gap-3 rounded-2xl border border-rose-400/40 bg-rose-500/10 p-4 hover:bg-rose-500/15 transition"
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-rose-400 animate-pulse" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-rose-100">{m.title}</span>
            <span className="block text-xs text-rose-200/80">
              {m.kind === "call" ? "Private call" : "Group meeting"} · {m.invitedCount} invited
            </span>
          </span>
          <span className="shrink-0 rounded-full bg-rose-400 px-3 py-1.5 text-xs font-semibold text-slate-950">Live now · Join</span>
        </a>
      ))}

      <section aria-labelledby="upcoming-heading" className="space-y-2">
        <h3 id="upcoming-heading" className="text-xs uppercase tracking-widest text-slate-400">Upcoming</h3>
        {later.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/20 p-6 text-center text-sm text-slate-400">
            No meetings coming up.
          </p>
        ) : (
          <ul className="grid gap-2">
            {later.map((m) => {
              const startsIn = Date.parse(m.start) - now;
              const joinable = startsIn <= JOIN_EARLY_MS;
              return (
                <li key={m.id} className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-slate-100">
                        {m.title}
                        {m.seriesId ? <span className="ml-2 text-xs text-slate-400">· repeats</span> : null}
                      </div>
                      <div className="text-xs text-slate-400">
                        {when(m.start)} · {duration(m.durationMin)} · {m.invitedCount} invited
                      </div>
                    </div>
                    {joinable ? (
                      <a href={`/${encodeURIComponent(m.slug)}`} className="shrink-0 px-3 py-1.5 rounded-full bg-cyan-500 text-slate-950 text-xs font-medium hover:bg-cyan-400 transition">
                        Join
                      </a>
                    ) : null}
                    {canSchedule && m.state === "scheduled" ? (
                      <>
                        <button type="button" onClick={() => setEditing(m)} className="shrink-0 px-3 py-1.5 rounded-full border border-slate-700 text-slate-200 hover:border-slate-500 transition text-xs">
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setCancelErr(null);
                            setCancelScope("this");
                            setCancelling(m);
                          }}
                          className="shrink-0 px-3 py-1.5 rounded-full border border-rose-500/40 text-rose-200 hover:bg-rose-500/15 transition text-xs"
                        >
                          Cancel
                        </button>
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="past-heading" className="space-y-2">
        <h3 id="past-heading" className="text-xs uppercase tracking-widest text-slate-400">Past</h3>
        {pastLoaded && past.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/20 p-6 text-center text-sm text-slate-400">
            No meetings yet.
          </p>
        ) : (
          <ul className="grid gap-2">
            {past.map((m) => (
              <li key={m.id} className="min-w-0 flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/30 p-3">
                <div className="min-w-0 flex-1">
                  {canViewReports ? (
                    <a
                      href={`/dashboard/groups/${encodeURIComponent(groupId)}/reports/${encodeURIComponent(m.id)}`}
                      className="block truncate text-sm text-slate-200 hover:text-cyan-200"
                    >
                      {m.title}
                    </a>
                  ) : (
                    <div className="truncate text-sm text-slate-200">{m.title}</div>
                  )}
                  <div className="text-xs text-slate-400">
                    {when(m.start)} · {duration(m.durationMin)}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-slate-300">
                  {m.attendedCount ?? 0} / {m.invitedCount} attended
                </span>
              </li>
            ))}
          </ul>
        )}
        {pastCursor !== null ? (
          <button type="button" onClick={loadMore} disabled={loadingMore} className="text-xs text-cyan-300 hover:text-cyan-200 disabled:opacity-60">
            {loadingMore ? "Loading…" : "Show older meetings"}
          </button>
        ) : null}
      </section>

      {err ? <p className="text-xs text-rose-300">{err}</p> : null}

      {editing ? (
        <ScheduleDialog
          groupId={groupId}
          groupName={groupName}
          editing={editing}
          onClose={() => setEditing(null)}
          onDone={(message) => {
            setEditing(null);
            onChanged(message);
          }}
        />
      ) : null}

      {cancelling ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => !cancelBusy && setCancelling(null)}
        >
          <div ref={cancelBoxRef} onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-2xl border border-rose-500/30 bg-[#0a0b12] text-slate-100 shadow-2xl overflow-hidden">
            <div className="px-6 py-5 space-y-3 text-sm">
              <h2 id="cancel-title" className="text-lg font-semibold text-slate-100">Cancel “{cancelling.title}”?</h2>
              <p className="text-slate-300">Everyone invited is told, and it is taken off their calendar.</p>
              {cancelling.seriesId ? (
                <fieldset className="space-y-2">
                  {(["this", "following"] as const).map((s) => (
                    <label key={s} className="flex items-center gap-2 text-slate-200">
                      <input type="radio" name="cancel-scope" checked={cancelScope === s} onChange={() => setCancelScope(s)} className="h-4 w-4 accent-rose-400" />
                      {s === "this" ? "This meeting" : "This and following meetings"}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {cancelErr ? <div className="text-xs text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{cancelErr}</div> : null}
            </div>
            <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-900/40">
              <button type="button" onClick={() => setCancelling(null)} disabled={cancelBusy} className="px-4 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-sm disabled:opacity-50">
                Keep it
              </button>
              <button type="button" onClick={confirmCancel} disabled={cancelBusy} className="px-4 py-2 rounded-full bg-rose-500 text-slate-950 font-medium hover:bg-rose-400 transition text-sm disabled:opacity-60">
                {cancelBusy ? "Cancelling…" : "Cancel meeting"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
