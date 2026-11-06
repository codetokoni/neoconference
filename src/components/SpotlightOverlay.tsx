'use client';

// src/components/SpotlightOverlay.tsx
//
// Host-controlled spotlight: one person highlighted for everyone in the
// meeting. A host or moderator picks them from the tile's menu ("Spotlight
// for everyone"; on a phone also a double tap on the tile). The choice is
// broadcast on the LiveKit DataChannel topic `neo-spotlight`, and every
// client then highlights that person's tiles (CSS) and shows a chip saying
// who is spotlit.
//
// Spotlight is the meeting-wide action; enlarging a tile is this screen's
// own (LiveKit's enlarge button, or a double-click on a computer). They used
// to share the double-click: a host's double-click enlarged the tile on
// their screen and was meant to spotlight it for everyone too, but on a
// computer it never did, because LiveKit's tiles carried no identity.
//
// This file does NOT replace the LiveKit grid layout - it overlays a class on
// the existing tiles by identity to keep things simple and resilient.

import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, type Participant, type RemoteParticipant, type DataPacket_Kind } from "livekit-client";
import { TILE_IDENTITY_SELECTOR, tileIdentityOf } from "@/components/conference/roomLayout";

const TOPIC = "neo-spotlight";
const REQUEST = "neo-spotlight-request";

type Msg = { identity: string | null; ts: number };

type Props = { isHost?: boolean };

/**
 * Spotlight this person for everyone, or take the spotlight off them if they
 * have it. Only a host's or moderator's SpotlightOverlay acts on it.
 */
export function requestSpotlight(identity: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(REQUEST, { detail: identity }));
}

// Who has the spotlight now, for the tile menus' "Remove spotlight".
let spotlit: string | null = null;
const watchers = new Set<() => void>();
function setSpotlit(identity: string | null) {
  if (identity === spotlit) return;
  spotlit = identity;
  watchers.forEach((w) => w());
}

/** The identity spotlit for everyone in this meeting, or null. */
export function useSpotlit(): string | null {
  return useSyncExternalStore(
    (w) => {
      watchers.add(w);
      return () => watchers.delete(w);
    },
    () => spotlit,
    () => null,
  );
}

export default function SpotlightOverlay({ isHost = false }: Props) {
  const room = useRoomContext();
  const [pinned, setPinned] = useState<string | null>(null);
  const [pinnedAt, setPinnedAt] = useState<number>(0);
  const pinnedRef = useRef<string | null>(null);
  pinnedRef.current = pinned;
  const pinnedAtRef = useRef(0);
  pinnedAtRef.current = pinnedAt;
  useEffect(() => setSpotlit(pinned), [pinned]);
  useEffect(() => () => setSpotlit(null), []);

  // Apply CSS class to the pinned participant's tiles in the DOM.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const apply = () => {
      document.querySelectorAll<HTMLElement>(TILE_IDENTITY_SELECTOR).forEach((t) => {
        if (!t.classList.contains("lk-participant-tile")) return;
        const id = tileIdentityOf(t);
        t.classList.toggle("neo-spotlight", !!id && id === pinnedRef.current);
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
    const onData = (payload: Uint8Array, _participant?: RemoteParticipant, _kind?: DataPacket_Kind, topic?: string) => {
      if (topic !== TOPIC) return;
      try {
        const msg: Msg = JSON.parse(dec.decode(payload));
        if (typeof msg.ts !== "number") return;
        if (msg.ts < pinnedAt) return;
        setPinnedAt(msg.ts);
        setPinned(msg.identity || null);
      } catch {}
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => { room.off(RoomEvent.DataReceived, onData); };
  }, [room, pinnedAt]);

  const broadcast = useCallback(async (identity: string | null) => {
    if (!room) return;
    const ts = Date.now();
    setPinned(identity);
    setPinnedAt(ts);
    try {
      const payload = new TextEncoder().encode(JSON.stringify({ identity, ts } as Msg));
      await room.localParticipant.publishData(payload, { reliable: true, topic: TOPIC });
    } catch (e) {
      console.error("spotlight publishData failed", e);
    }
  }, [room]);

  // A host's or moderator's request from a tile menu.
  useEffect(() => {
    if (!isHost) return;
    const onRequest = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id) return;
      broadcast(pinnedRef.current === id ? null : id);
    };
    window.addEventListener(REQUEST, onRequest);
    return () => window.removeEventListener(REQUEST, onRequest);
  }, [isHost, broadcast]);

  useEffect(() => {
    if (!room) return;
    // Someone who joins after the spotlight was set heard nothing (it is a
    // message, not stored): a host tells them, with the original time so
    // a newer choice still wins.
    const onJoin = (p: RemoteParticipant) => {
      if (!isHost || !pinnedRef.current) return;
      const payload = new TextEncoder().encode(
        JSON.stringify({ identity: pinnedRef.current, ts: pinnedAtRef.current } as Msg),
      );
      room.localParticipant
        .publishData(payload, { reliable: true, topic: TOPIC, destinationIdentities: [p.identity] })
        .catch((err) => console.error("spotlight catch-up failed", err));
    };
    // The spotlit person left: nothing to highlight, so the chip goes.
    const onLeave = (p: Participant) => {
      if (p.identity === pinnedRef.current) setPinned(null);
    };
    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.ParticipantDisconnected, onLeave);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.ParticipantDisconnected, onLeave);
    };
  }, [room, isHost]);

  // Render a small status chip + clear button when pinned (and host).
  if (!pinned) {
    if (!isHost) return null;
    return (
      <div className={"pointer-events-none fixed bottom-24 left-1/2 -translate-x-1/2 z-40 px-3 py-1.5 rounded-full bg-slate-900/70 border border-cyan-500/20 text-[11px] text-slate-400 backdrop-blur"}>
        Spotlight someone for everyone from their tile&apos;s ⋮ menu
      </div>
    );
  }

  const who = pinned === room?.localParticipant?.identity
    ? "You"
    : room?.remoteParticipants.get(pinned)?.name || room?.remoteParticipants.get(pinned)?.identity || pinned;

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
        <span className={"font-medium"}>Spotlight for everyone: {who}</span>
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
