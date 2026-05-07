"use client";

import { useParticipants } from "@livekit/components-react";

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
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px 6px 10px",
        borderRadius: 999,
        background: "rgba(8, 18, 34, 0.72)",
        color: "#cffafe",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.2,
        border: "1px solid rgba(103, 232, 249, 0.32)",
        boxShadow: "0 0 18px rgba(34, 211, 238, 0.18), inset 0 1px 0 rgba(255,255,255,0.04)",
        backdropFilter: "blur(14px)",
      }}
    >
      <span aria-hidden style={{ position: "relative", width: 8, height: 8, display: "inline-block" }}>
        <span style={{ position: "absolute", inset: 0, borderRadius: 9999, background: "rgba(103, 232, 249, 0.55)", animation: "neo-count-ping 1.7s cubic-bezier(0,0,0.2,1) infinite" }} />
        <span style={{ position: "absolute", inset: 0, borderRadius: 9999, background: "#22d3ee", boxShadow: "0 0 10px rgba(34,211,238,0.85)" }} />
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
          <path d="M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 0a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3 0-8 1.5-8 4.5V20h10v-2.5c0-1.1.4-2 1-2.7C9.5 13.3 8.7 13 8 13Zm8 0c-.7 0-1.5.3-2.4.7.6.7 1 1.6 1 2.7V20h9v-2.5C23.6 14.5 18.6 13 16 13Z" />
        </svg>
        {label}
      </span>
      <style>{`@keyframes neo-count-ping { 75%, 100% { transform: scale(2.2); opacity: 0; } }`}</style>
    </div>
  );
}

