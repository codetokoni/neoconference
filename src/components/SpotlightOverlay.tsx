'use client';

// src/components/SpotlightOverlay.tsx
//
// Host-controlled spotlight pinning. The host clicks a participant tile to
// pin them; the chosen identity is broadcast to every participant via the
// LiveKit DataChannel topic `neo-spotlight`. Every client then highlights the
// pinned tile (CSS) and shows a small "Pinned" chip in the corner.
//
// This file does NOT replace the LiveKit grid layout - it overlays a class on
// the existing tiles by identity to keep things simple and resilient.

import { useEffect, useRef, useState, useCallback } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";

const TOPIC = "neo-spotlight";

type Msg = { identity: string | null; ts: number };

type Props = { isHost?: boolean };

export default function SpotlightOverlay({ isHost = false }: Props) {
  const room = useRoomContext();
  const [pinned, setPinned] = useState<string | null>(null);
  const [pinnedAt, setPinnedAt] = useState<number>(0);
  const pinnedRef = useRef<string | null>(null);
  pinnedRef.current = pinned;

  // Apply CSS class to the pinned participant tile in the DOM.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const apply = () => {
      const tiles = document.querySelectorAll<HTMLElement>("[data-lk-participant-identity]");
      tiles.forEach((t) => {
        const id = t.getAttribute("data-lk-participant-identity");
        if (id && id === pinnedRef.current) {
          t.classList.add("neo-spotlight");
        } else {
          t.classList.remove("neo-spotlight");
        }
      });
    };
    apply();
    const id = window.setInterval(apply, 600);
    return () => window.clearInterval(id);
  }, [pinned]);

  // Listen for spotlight broadcasts from the host.
  useEffect(() => {
    if (!room) return;
    const dec = new TextDecoder();
    const onData = (payload: Uint8Array, _participant: any, _kind: any, topic?: string) => {
      if (topic !== TOPIC) return;
      try {
        const msg: Msg = JSON.parse(dec.decode(payload));
        if (typeof msg.ts !== "number") return;
        if (msg.ts < pinnedAt) return;
        setPinnedAt(msg.ts);
        setPinned(msg.identity || null);
      } catch {}
    };
    room.on(RoomEvent.DataReceived, onData as any);
    return () => { room.off(RoomEvent.DataReceived, onData as any); };
  }, [room, pinnedAt]);

  const broadcast = useCallback(async (identity: string | null) => {
    if (!room) return;
    const ts = Date.now();
    setPinned(identity);
    setPinnedAt(ts);
    try {
      const payload = new TextEncoder().encode(JSON.stringify({ identity, ts } as Msg));
      await room.localParticipant.publishData(payload, { reliable: true, topic: TOPIC } as any);
    } catch (e) {
      console.error("spotlight publishData failed", e);
    }
  }, [room]);

  // Bind click handlers to all tiles when host. Re-bind periodically as tiles
  // can mount/unmount.
  useEffect(() => {
    if (!isHost || typeof document === "undefined") return;
    const handler = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tile = target.closest<HTMLElement>("[data-lk-participant-identity]");
      if (!tile) return;
      // Avoid hijacking control buttons inside the tile.
      if (target.closest("button, [role="button"], a, input, select")) return;
      const id = tile.getAttribute("data-lk-participant-identity");
      if (!id) return;
      e.preventDefault();
      broadcast(pinnedRef.current === id ? null : id);
    };
    document.addEventListener("dblclick", handler, true);
    return () => document.removeEventListener("dblclick", handler, true);
  }, [isHost, broadcast]);

  // Render a small status chip + clear button when pinned (and host).
  if (!pinned) {
    if (!isHost) return null;
    return (
      <div className={"pointer-events-none fixed bottom-24 left-1/2 -translate-x-1/2 z-40 px-3 py-1.5 rounded-full bg-slate-900/70 border border-cyan-500/20 text-[11px] text-slate-400 backdrop-blur"}>
        Double-click any tile to spotlight
      </div>
    );
  }

  return (
    <>
      <style jsx global>{`
        .neo-spotlight {
          outline: 2px solid rgb(34 211 238 / 0.9) !important;
          box-shadow: 0 0 0 2px rgb(34 211 238 / 0.25), 0 10px 40px rgb(34 211 238 / 0.15) !important;
          border-radius: 12px !important;
          transform: scale(1.01);
          transition: transform 250ms ease, box-shadow 250ms ease;
          z-index: 10;
        }
      `}</style>
      <div data-room-chrome={"true"} className={"fixed bottom-24 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 py-1.5 rounded-full bg-cyan-500/15 border border-cyan-400/40 text-cyan-200 text-xs backdrop-blur shadow-[0_0_24px_rgba(34,211,238,0.25)]"}>
        <span className={"inline-block w-1.5 h-1.5 rounded-full bg-cyan-300 animate-pulse"}></span>
        <span className={"font-medium"}>Spotlight: {pinned}</span>
        {isHost && (
          <button
            type={"button"}
            onClick={() => broadcast(null)}
            className={"ml-1 px-2 py-0.5 rounded-full bg-slate-900/60 hover:bg-slate-800 text-slate-200 text-[10px] uppercase tracking-wider"}
          >
            Clear
          </button>
        )}
      </div>
    </>
  );
}

