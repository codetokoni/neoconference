"use client";

import { useParticipants } from "@livekit/components-react";
import { User } from "lucide-react";

/**
 * Live participant counter shown in the room toolbar.
 * Uses LiveKit's useParticipants hook so the number stays
 * in sync as people join or leave in real time.
 */
export default function ParticipantCountBadge() {
  const participants = useParticipants();
  const total = participants.length;
  const label = total === 1 ? "1 in room" : total + " in room";

  return (
    <div
      data-room-chrome="true"
      title="Live participants"
      className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/40 px-2.5 py-1 text-xs text-neutral-300"
    >
      <User size={14} aria-hidden />
      {label}
    </div>
  );
}
