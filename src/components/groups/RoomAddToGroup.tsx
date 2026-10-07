"use client";

// "Add people to a group", inside the room's participants panel, in any
// meeting — not only a group meeting. Hosts and moderators: the people here
// (signed-in ones; one person on two devices once), or anyone by KingsChat
// handle or email, into one of their groups or a new one.
//
// A new group made here is not made "from the meeting's attendees": that
// needs host rank on the meeting, and moderators use this too. Everyone goes
// through the members route, where someone with no account yet is pending.

import { useState } from "react";
import AddToGroupDialog, { type GroupCandidate } from "@/components/groups/AddToGroupDialog";
import type { RoomPerson } from "@/lib/roomPeople";

/** The people here as candidates: accounts only, each once, not you, none ticked. */
export function roomCandidates(people: RoomPerson[], meId: string): GroupCandidate[] {
  const seen = new Set<string>();
  const out: GroupCandidate[] = [];
  for (const p of people) {
    if (!p.userId.startsWith("user_") || p.userId === meId || seen.has(p.userId)) continue;
    seen.add(p.userId);
    out.push({ name: p.name || p.userId, detail: "In the meeting", userId: p.userId, attended: true });
  }
  return out;
}

export default function RoomAddToGroup({ people, meId }: { people: RoomPerson[]; meId: string }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <button
        type="button"
        onClick={() => {
          setMsg(null);
          setOpen(true);
        }}
        style={{
          width: "100%",
          padding: "8px 10px",
          borderRadius: 8,
          border: "1px solid rgba(34,211,238,0.5)",
          background: "rgba(34,211,238,0.12)",
          color: "#cffafe",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        Add people to a group
      </button>
      {msg ? (
        <div role="status" style={{ marginTop: 8, fontSize: 12, color: "#bbf7d0" }}>
          {msg}
        </div>
      ) : null}
      <AddToGroupDialog
        open={open}
        onClose={() => setOpen(false)}
        candidates={roomCandidates(people, meId)}
        onDone={(message) => {
          setOpen(false);
          setMsg(message);
        }}
      />
    </div>
  );
}
