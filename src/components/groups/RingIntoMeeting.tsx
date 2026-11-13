"use client";

// "Call people in", inside the room's participants panel, for a meeting that
// is not a group meeting (your room, a meeting from your list): ring members
// of one of your groups into this meeting, now. A group meeting has its own
// Add participants and Calling instead.
//
// Renders nothing for anyone who may not invite people into this meeting,
// for a group meeting, or once the meeting is over. Their answers show in
// the Calling panel below it (GroupCallingPanel), which this tells to look.

import { useEffect, useMemo, useState } from "react";
import MemberPicker, { type PickableMember } from "@/components/groups/MemberPicker";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";

interface CallableGroup {
  id: string;
  name: string;
  members: PickableMember[];
}

/** Tells the Calling panel that people were just rung in. */
export const CALLS_CHANGED = "neo-calls-changed";

export default function RingIntoMeeting({ slug }: { slug: string }) {
  const [info, setInfo] = useState<{ open: boolean; groups: CallableGroup[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/events/${encodeURIComponent(slug)}/ring-in`, { cache: "no-store" });
        const data = res.ok ? ((await res.json()) as { open: boolean; groups: CallableGroup[] }) : null;
        if (!cancelled) {
          setInfo(data);
          if (data?.groups.length) setGroupId((g) => g || data.groups[0].id);
        }
      } catch {
        if (!cancelled) setInfo(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const group = useMemo(() => info?.groups.find((g) => g.id === groupId) ?? null, [info, groupId]);

  if (!info?.open) return null;

  async function ring() {
    if (!group || picked.size === 0) {
      setMsg({ kind: "err", text: "Choose who to call." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/ring-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupId: group.id, userIds: Array.from(picked) }),
      });
      if (!res.ok) {
        setMsg({ kind: "err", text: await groupErrorFrom(res) });
        return;
      }
      const data = (await res.json()) as { rung: string[]; busy: string[] };
      const n = data.rung.length;
      const b = data.busy.length;
      setMsg({
        kind: "ok",
        text:
          (n ? `Ringing ${n} ${n === 1 ? "person" : "people"}.` : "") +
          (b ? ` ${b} ${b === 1 ? "is" : "are"} in another meeting and got a message instead.` : "") ||
          "They have already joined or answered.",
      });
      setPicked(new Set());
      window.dispatchEvent(new Event(CALLS_CHANGED));
    } catch {
      setMsg({ kind: "err", text: groupErrorMessage(null) });
    } finally {
      setBusy(false);
    }
  }

  const allPicked = !!group && group.members.length > 0 && group.members.every((m) => picked.has(m.userId));

  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "#e2e8f0" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: "100%",
          padding: "8px 10px",
          fontSize: 12,
          fontWeight: 600,
          borderRadius: 6,
          border: "1px solid rgba(34,211,238,0.45)",
          background: "rgba(34,211,238,0.10)",
          color: "#cffafe",
          cursor: "pointer",
        }}
      >
        {open ? "Close" : "Call people in"}
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          {info.groups.length === 0 ? (
            <p className="text-xs text-slate-400">
              Calling people in uses your groups. You have none you may call from yet:{" "}
              <a href="/dashboard/groups" className="text-cyan-300 underline">
                make a group
              </a>
              .
            </p>
          ) : (
            <>
              {info.groups.length > 1 ? (
                <label className="block text-xs text-slate-300">
                  From group
                  <select
                    value={groupId}
                    onChange={(e) => {
                      setGroupId(e.target.value);
                      setPicked(new Set());
                      setMsg(null);
                    }}
                    className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-sm text-slate-100"
                  >
                    {info.groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} ({g.members.length})
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="text-xs text-slate-400">From {info.groups[0].name}</p>
              )}
              {group && group.members.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setPicked(allPicked ? new Set() : new Set(group.members.map((m) => m.userId)))}
                  className="text-xs text-cyan-300 underline"
                >
                  {allPicked ? "Clear" : `Everyone in ${group.name}`}
                </button>
              ) : null}
              {group ? (
                <MemberPicker members={group.members} selected={picked} onChange={setPicked} emptyText="There is no one else in this group yet." />
              ) : null}
              <button
                type="button"
                onClick={ring}
                disabled={busy || picked.size === 0}
                className="w-full rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 transition disabled:opacity-60"
              >
                {busy ? "Calling…" : picked.size ? `Call ${picked.size} ${picked.size === 1 ? "person" : "people"}` : "Call"}
              </button>
            </>
          )}
          {msg ? (
            <p role={msg.kind === "err" ? "alert" : "status"} className={"text-xs " + (msg.kind === "err" ? "text-rose-300" : "text-emerald-300")}>
              {msg.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
