'use client';

// src/components/RaiseHandButton.tsx
//
// Floating raise-hand button for attendees + a roster popover for hosts.
// Uses LiveKit DataChannel topic "neo-hand" with payload { id, name, on, ts }.
// Each participant tracks their own state; hosts see all currently-raised hands.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';

const TOPIC = 'neo-hand';

type Hand = { id: string; name: string; raisedAt: number };

type Props = { isHost?: boolean };

export default function RaiseHandButton({ isHost = false }: Props) {
  const room = useRoomContext();
  const [raised, setRaised] = useState(false);
  const [hands, setHands] = useState<Map<string, Hand>>(new Map());
  const [showRoster, setShowRoster] = useState(false);
  const handsRef = useRef(hands);
  handsRef.current = hands;

  useEffect(() => {
    if (!room) return;
    const dec = new TextDecoder();
    const handler = (payload: Uint8Array, _p: any, _k: any, topic?: string) => {
      if (topic && topic !== TOPIC) return;
      try {
        const m = JSON.parse(dec.decode(payload));
        if (!m || typeof m.id !== "string") return;
        setHands((prev) => {
          const next = new Map(prev);
          if (m.on) next.set(m.id, { id: m.id, name: String(m.name || "Guest"), raisedAt: Number(m.ts) || Date.now() });
          else next.delete(m.id);
          return next;
        });
      } catch {}
    };
    room.on(RoomEvent.DataReceived, handler as any);
    return () => { room.off(RoomEvent.DataReceived, handler as any); };
  }, [room]);

  const toggle = useCallback(async () => {
    if (!room?.localParticipant) return;
    const next = !raised;
    setRaised(next);
    const me = room.localParticipant;
    const id = me.identity || me.sid;
    const name = me.name || me.identity || "Guest";
    setHands((prev) => {
      const m = new Map(prev);
      if (next) m.set(id, { id, name, raisedAt: Date.now() });
      else m.delete(id);
      return m;
    });
    try {
      const enc = new TextEncoder();
      await me.publishData(enc.encode(JSON.stringify({ id, name, on: next, ts: Date.now() })), { reliable: true, topic: TOPIC });
    } catch {}
  }, [raised, room]);

  const handCount = hands.size;

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={raised}
        title={raised ? "Lower hand" : "Raise hand"}
        style={{
          position: "fixed",
          bottom: 90,
          right: 18,
          zIndex: 70,
          width: 44,
          height: 44,
          borderRadius: 22,
          fontSize: 22,
          background: raised ? "#fbbf24" : "rgba(15,23,42,0.7)",
          color: raised ? "#0e1530" : "#fbbf24",
          border: "1px solid rgba(251,191,36,0.4)",
          cursor: "pointer",
          backdropFilter: "blur(10px)",
          boxShadow: raised ? "0 0 24px rgba(251,191,36,0.4)" : "none",
        }}
      >
        ✋
      </button>

      {isHost && handCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowRoster((v) => !v)}
          style={{ position: "fixed", bottom: 90, right: 72, zIndex: 70, padding: "6px 12px", borderRadius: 16, background: "#fbbf24", color: "#0e1530", border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
        >
          {handCount} hand{handCount === 1 ? "" : "s"}
        </button>
      ) : null}

      {isHost && showRoster ? (
        <div
          style={{ position: "fixed", bottom: 140, right: 18, zIndex: 70, width: 240, maxHeight: 320, overflowY: "auto", padding: 12, borderRadius: 12, background: "rgba(8,11,20,0.92)", border: "1px solid rgba(251,191,36,0.35)", color: "#e2e8f0", backdropFilter: "blur(14px)" }}
        >
          <p style={{ margin: 0, fontSize: 11, letterSpacing: 1.4, color: "#fbbf24", textTransform: "uppercase" }}>Raised hands</p>
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 6 }}>
            {[...hands.values()].sort((a,b) => a.raisedAt - b.raisedAt).map((h) => (
              <li key={h.id} style={{ fontSize: 13, padding: "6px 8px", borderRadius: 8, background: "rgba(251,191,36,0.08)" }}>
                <span style={{ marginRight: 6 }}>✋</span>{h.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

