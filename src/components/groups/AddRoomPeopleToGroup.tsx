"use client";

// "Add to group", inside the room's participants panel, for group meetings:
// someone who came into the meeting on a link but is not in the group can be
// added to it from here, by their account — no email needed. Moderators and
// above only, as on the group's Members tab (group:members:manage).
//
// Signed-out guests have no account to add; they need the invite link.
// Renders nothing outside a group meeting, for anyone who may not add
// members, or when everyone here is already in the group.

import { useCallback, useEffect, useState } from "react";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";
import { notInGroup, type RoomPerson } from "@/lib/roomPeople";

interface GroupInfo {
  groupId: string;
  groupName: string;
  memberIds: Set<string>;
  canAdd: boolean;
}

export default function AddRoomPeopleToGroup({ slug, people, meId }: { slug: string; people: RoomPerson[]; meId: string }) {
  const [info, setInfo] = useState<GroupInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/participants`, { cache: "no-store" });
      if (!res.ok) return setInfo(null);
      const meeting = (await res.json()) as { groupId?: string; groupName?: string };
      if (!meeting.groupId) return setInfo(null);
      const g = await fetch(`/api/groups/${encodeURIComponent(meeting.groupId)}`, { cache: "no-store" });
      if (!g.ok) return setInfo(null);
      const data = (await g.json()) as {
        group: { name: string };
        members: Array<{ userId: string }>;
        capabilities: { manageMembers: boolean };
      };
      setInfo({
        groupId: meeting.groupId,
        groupName: data.group.name || meeting.groupName || "the group",
        memberIds: new Set(data.members.map((m) => m.userId)),
        canAdd: data.capabilities.manageMembers,
      });
    } catch {
      setInfo(null);
    }
  }, [slug]);

  useEffect(() => {
    if (slug) void load();
  }, [slug, load]);

  if (!info?.canAdd) return null;
  const list = notInGroup(people, info.memberIds, meId);
  if (list.length === 0 && !msg) return null;

  async function add(p: RoomPerson) {
    if (!info) return;
    setBusy(p.userId);
    setMsg(null);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(info.groupId)}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userIds: [p.userId] }),
      });
      if (!res.ok) {
        setMsg(await groupErrorFrom(res));
        return;
      }
      const data = (await res.json()) as { added: unknown[]; alreadyMembers: string[] };
      const name = p.name || "They";
      setMsg(
        data.added.length > 0
          ? `${name} is now in ${info.groupName}.`
          : data.alreadyMembers.length > 0
            ? `${name} is already in ${info.groupName}.`
            : `Could not add ${name}.`
      );
      await load();
    } catch {
      setMsg(groupErrorMessage(null));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "#e2e8f0" }}>
      {list.length > 0 ? (
        <>
          <div className="text-xs font-semibold text-slate-200">Here, not in {info.groupName}</div>
          <ul className="mt-2 space-y-1.5">
            {list.map((p) => (
              <li key={p.userId} className="flex items-center gap-2 rounded-lg bg-slate-900/60 border border-slate-800 px-2.5 py-2">
                <div className="min-w-0 flex-1 truncate text-sm text-slate-100">{p.name || "Someone"}</div>
                <button
                  type="button"
                  onClick={() => add(p)}
                  disabled={busy !== null}
                  aria-label={`Add ${p.name || "this person"} to ${info.groupName}`}
                  className="shrink-0 rounded-full border border-cyan-400/50 px-2.5 py-1 text-xs text-cyan-100 hover:bg-cyan-500/15 transition disabled:opacity-60"
                >
                  {busy === p.userId ? "Adding…" : "Add to group"}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {msg ? <p className="mt-2 text-xs text-slate-300">{msg}</p> : null}
    </div>
  );
}
