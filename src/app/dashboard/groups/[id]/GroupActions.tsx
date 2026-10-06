"use client";

// The group's "Start meeting", "Schedule" and "Call" buttons, each shown only
// to a rank that may use it (the routes check again regardless).

import { useState } from "react";
import type { GroupCapabilities, GroupMember } from "@/lib/groupStore";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";
import ScheduleDialog, { viewerTimezone } from "./ScheduleDialog";
import MemberPicker from "@/components/groups/MemberPicker";

/** Into the meeting room for a live group meeting or call. */
export function roomHref(slug: string): string {
  return `/room/${encodeURIComponent(slug)}?event=${encodeURIComponent(slug)}`;
}

export default function GroupActions({
  groupId,
  groupName,
  members,
  meId,
  capabilities,
  onChanged,
}: {
  groupId: string;
  groupName: string;
  members: GroupMember[];
  meId: string;
  capabilities: GroupCapabilities;
  /** A meeting was created or changed, with a line to show about it. */
  onChanged: (message: string) => void;
}) {
  const [scheduling, setScheduling] = useState(false);
  const [calling, setCalling] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"start" | "call" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!capabilities.start && !capabilities.schedule && !capabilities.call) return null;
  const others = members.filter((m) => m.userId !== meId);

  async function startNow() {
    setBusy("start");
    setErr(null);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/meetings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "now", title: `${groupName} meeting`, timezone: viewerTimezone() }),
      });
      if (!res.ok) {
        setErr(await groupErrorFrom(res));
        setBusy(null);
        return;
      }
      const data = (await res.json()) as { slug: string };
      window.location.assign(roomHref(data.slug));
    } catch {
      setErr(groupErrorMessage(null));
      setBusy(null);
    }
  }

  async function startCall() {
    if (picked.size === 0) {
      setErr("Choose at least one member to call.");
      return;
    }
    setBusy("call");
    setErr(null);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userIds: Array.from(picked), timezone: viewerTimezone() }),
      });
      if (!res.ok) {
        setErr(await groupErrorFrom(res));
        setBusy(null);
        return;
      }
      const data = (await res.json()) as { slug: string };
      window.location.assign(roomHref(data.slug));
    } catch {
      setErr(groupErrorMessage(null));
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {capabilities.start ? (
          <button type="button" onClick={startNow} disabled={busy !== null} className="neo-btn text-sm px-4 py-2.5 disabled:opacity-60">
            {busy === "start" ? "Starting…" : "Start meeting"}
          </button>
        ) : null}
        {capabilities.schedule ? (
          <button type="button" onClick={() => setScheduling(true)} disabled={busy !== null} className="neo-btn-ghost text-sm px-4 py-2.5">
            Schedule
          </button>
        ) : null}
        {capabilities.call ? (
          <button
            type="button"
            onClick={() => {
              setErr(null);
              setPicked(new Set());
              setCalling(true);
            }}
            disabled={busy !== null}
            className="neo-btn-ghost text-sm px-4 py-2.5"
          >
            Call
          </button>
        ) : null}
      </div>
      {err && !calling ? <p className="text-xs text-rose-300">{err}</p> : null}

      {scheduling ? (
        <ScheduleDialog
          groupId={groupId}
          groupName={groupName}
          onClose={() => setScheduling(false)}
          onDone={(message) => {
            setScheduling(false);
            onChanged(message);
          }}
        />
      ) : null}

      {calling ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="call-title"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4"
          onClick={() => busy === null && setCalling(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-md max-h-[90vh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-slate-800 bg-[#0a0b12] text-slate-100 shadow-2xl overflow-hidden"
          >
            <div className="px-6 py-5 border-b border-slate-800">
              <h2 id="call-title" className="text-lg font-semibold text-slate-100">Private call</h2>
              <p className="text-xs text-slate-400 mt-1">
                Only the people you choose can join. You can add more once it has started.
              </p>
            </div>
            <div className="px-6 py-5 overflow-y-auto space-y-3">
              <MemberPicker members={others} selected={picked} onChange={setPicked} emptyText="There is no one else in this group yet." />
              {err ? <div className="text-xs text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{err}</div> : null}
            </div>
            <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-between gap-2 bg-slate-900/40">
              <span className="text-xs text-slate-400">{picked.size} selected</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => setCalling(false)} disabled={busy !== null} className="px-4 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-sm disabled:opacity-50">
                  Cancel
                </button>
                <button type="button" onClick={startCall} disabled={busy !== null || picked.size === 0} className="px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm disabled:opacity-60">
                  {busy === "call" ? "Calling…" : "Start call"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

