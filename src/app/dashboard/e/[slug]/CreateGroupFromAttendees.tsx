"use client";

// "Create group from attendees" — turns the people who were in this meeting
// into a group. Everyone signed in starts ticked; guests have no account to
// add, so they are shown greyed out and reached through an invite link later.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";

interface Attendee {
  userId: string;
  name: string;
  email: string;
}

export default function CreateGroupFromAttendees({
  eventId,
  eventName,
  currentUserId,
}: {
  eventId: string;
  eventName: string;
  currentUserId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [guests, setGuests] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [name, setName] = useState(eventName);
  const [nameTouched, setNameTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const nameError = nameTouched && !name.trim() ? "Give the group a name." : null;

  async function openSheet() {
    setOpen(true);
    setErr(null);
    setName(eventName);
    setNameTouched(false);
    setLoading(true);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/attendees`, { cache: "no-store" });
      if (!res.ok) {
        setErr(await groupErrorFrom(res));
        setAttendees([]);
        setGuests([]);
        return;
      }
      const data = (await res.json()) as { attendees: Attendee[]; guests: Array<{ name: string }> };
      // You are the owner of the group you create, so you are not on the list.
      const others = data.attendees.filter((a) => a.userId !== currentUserId);
      setAttendees(others);
      setGuests(data.guests.map((g) => g.name));
      setChecked(new Set(others.map((a) => a.userId)));
    } catch {
      setErr(groupErrorMessage(null));
    } finally {
      setLoading(false);
    }
  }

  function close() {
    if (submitting) return;
    setOpen(false);
  }

  function toggle(userId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  const allChecked = attendees.length > 0 && checked.size === attendees.length;

  async function create() {
    setNameTouched(true);
    if (!name.trim()) return;
    setErr(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          fromEventId: eventId,
          memberUserIds: Array.from(checked),
        }),
      });
      if (!res.ok) {
        setErr(await groupErrorFrom(res));
        setSubmitting(false);
        return;
      }
      const data = (await res.json()) as { group: { id: string } };
      router.push(`/dashboard/groups/${encodeURIComponent(data.group.id)}`);
    } catch {
      setErr(groupErrorMessage(null));
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        className="px-4 py-2 rounded-full border border-cyan-400/50 text-cyan-100 hover:bg-cyan-500/15 transition text-sm font-medium"
      >
        Create group from attendees
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-group-title"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4"
          onClick={close}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-lg max-h-[90vh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-slate-800 bg-[#0a0b12] text-slate-100 shadow-2xl overflow-hidden"
          >
            <div className="px-6 py-5 border-b border-slate-800">
              <h2 id="create-group-title" className="text-lg font-semibold text-slate-100">
                Create group from attendees
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Everyone you keep ticked joins as a Member. You will be the Owner.
              </p>
            </div>

            <div className="px-6 py-5 space-y-5 overflow-y-auto text-sm text-slate-200">
              <div className="space-y-1.5">
                <label htmlFor="group-name" className="text-xs text-slate-400">
                  Group name
                </label>
                <input
                  id="group-name"
                  type="text"
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setNameTouched(true)}
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? "group-name-error" : undefined}
                  className={
                    "w-full px-3 py-2 rounded-lg bg-slate-900 text-slate-100 placeholder:text-slate-500 border focus:outline-none text-sm " +
                    (nameError ? "border-rose-500 focus:border-rose-400" : "border-slate-700 focus:border-cyan-400")
                  }
                />
                {nameError ? (
                  <p id="group-name-error" className="text-xs text-rose-300">
                    {nameError}
                  </p>
                ) : null}
              </div>

              {loading ? (
                <p className="text-slate-400">Loading who attended…</p>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase tracking-widest text-slate-400">
                      Attendees ({checked.size} of {attendees.length})
                    </span>
                    {attendees.length > 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setChecked(allChecked ? new Set() : new Set(attendees.map((a) => a.userId)))
                        }
                        className="text-xs text-cyan-300 hover:text-cyan-200"
                      >
                        {allChecked ? "Clear all" : "Select all"}
                      </button>
                    ) : null}
                  </div>

                  {attendees.length === 0 && guests.length === 0 && !err ? (
                    <p className="text-slate-400">
                      No one else was recorded in this meeting. You can still create the group and add people
                      afterwards.
                    </p>
                  ) : null}

                  <ul className="space-y-1">
                    {attendees.map((a) => (
                      <li key={a.userId}>
                        <label className="flex items-center gap-3 rounded-lg px-3 py-2 bg-slate-900/60 border border-slate-800 hover:border-slate-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked.has(a.userId)}
                            onChange={() => toggle(a.userId)}
                            className="h-4 w-4 accent-cyan-400"
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-slate-100">{a.name}</span>
                            {a.email ? <span className="block truncate text-xs text-slate-400">{a.email}</span> : null}
                          </span>
                        </label>
                      </li>
                    ))}
                    {guests.map((g, i) => (
                      <li key={`guest-${i}`}>
                        <div
                          aria-disabled="true"
                          className="flex items-center gap-3 rounded-lg px-3 py-2 bg-slate-900/30 border border-slate-800/60 opacity-60"
                        >
                          <input type="checkbox" disabled checked={false} readOnly className="h-4 w-4" />
                          <span className="min-w-0 flex-1 truncate text-slate-300">{g}</span>
                          <span className="text-xs text-slate-400 shrink-0">invite link only</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {err ? (
                <div className="text-xs text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
                  {err}
                </div>
              ) : null}
            </div>

            <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-900/40">
              <button
                type="button"
                onClick={close}
                disabled={submitting}
                className="px-4 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-sm disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={create}
                disabled={submitting || loading}
                className="px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm disabled:opacity-60"
              >
                {submitting ? "Creating…" : "Create group"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
