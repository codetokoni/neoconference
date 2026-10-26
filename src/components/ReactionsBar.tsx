'use client';

// src/components/ReactionsBar.tsx
//
// Floating emoji reactions for the live LiveKit room.
// Sends + receives via DataChannel (lossy) so it works without any
// backend persistence. Renders ephemeral floating emoji that drift up
// and fade. Place inside <LiveKitRoom> tree.
//
// Layout:
// - Desktop (>640px): one 😊 button on the right edge of the video area;
//   clicking it opens the vertical stack of reactions above it, clicking
//   it again closes them.
// - Mobile (<=640px): a single trigger button anchored bottom-right
//   above the mobile control bar. Tapping opens a compact horizontal
//   row of reactions that auto-closes on selection / outside tap.
//   This stops the vertical stack from overlapping the right column of
//   tiles in the 2x2 mobile grid.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, type RemoteParticipant, type DataPacket_Kind } from "livekit-client";

const REACTIONS = ['heart','thumbs','clap','laugh','wow','fire'] as const;
type ReactionKey = typeof REACTIONS[number];

const EMOJI: Record<ReactionKey, string> = {
  heart: '❤️',
  thumbs: '👍',
  clap: '👏',
  laugh: '😂',
  wow: '😮',
  fire: '🔥',
};

type Floating = { id: string; emoji: string; left: number };

const TOPIC = 'neo-reactions';

export default function ReactionsBar() {
  const room = useRoomContext();
  const [floats, setFloats] = useState<Floating[]>([]);
  const [isMobile, setIsMobile] = useState(false);
  const [, setPickerOpen] = useState(false);
  const idRef = useRef(0);

  // Track mobile breakpoint via matchMedia so we react to rotation / resize.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 640px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Close the mobile picker if the viewport leaves mobile mode mid-session.
  useEffect(() => {
    if (!isMobile) setPickerOpen(false);
  }, [isMobile]);

  const spawn = useCallback((emoji: string) => {
    const id = `r-${++idRef.current}`;
    const left = 10 + Math.random() * 80;
    setFloats((arr) => [...arr, { id, emoji, left }]);
    setTimeout(() => {
      setFloats((arr) => arr.filter((f) => f.id !== id));
    }, 2400);
  }, []);

  useEffect(() => {
    if (!room) return;
    const dec = new TextDecoder();
    const handler = (payload: Uint8Array, _participant?: RemoteParticipant, _kind?: DataPacket_Kind, topic?: string) => {
      if (topic && topic !== TOPIC) return;
      try {
        const msg = JSON.parse(dec.decode(payload));
        if (msg && typeof msg.k === 'string' && EMOJI[msg.k as ReactionKey]) {
          spawn(EMOJI[msg.k as ReactionKey]);
        }
      } catch {}
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => { room.off(RoomEvent.DataReceived, handler); };
  }, [room, spawn]);

  const send = useCallback(async (k: ReactionKey) => {
    spawn(EMOJI[k]);
    if (isMobile) setPickerOpen(false);
    if (!room?.localParticipant) return;
    try {
      const enc = new TextEncoder();
      const data = enc.encode(JSON.stringify({ k }));
      await room.localParticipant.publishData(data, { reliable: false, topic: TOPIC });
    } catch {}
  }, [room, spawn, isMobile]);

  // ---- Float overlay (shared on both layouts) ----
  const floatOverlay = (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 60,
        overflow: 'hidden',
      }}
    >
      {floats.map((f) => (
        <span
          key={f.id}
          style={{
            position: 'absolute',
            bottom: '12%',
            left: `${f.left}%`,
            fontSize: '32px',
            animation: 'neoFloat 2.4s ease-out forwards',
            willChange: 'transform, opacity',
          }}
        >
          {f.emoji}
        </span>
      ))}
    </div>
  );

  const keyframes = (
    <style>{`@keyframes neoFloat { 0% { transform: translateY(0) scale(0.6); opacity: 0; } 15% { opacity: 1; } 100% { transform: translateY(-260px) scale(1.15); opacity: 0; } }`}</style>
  );

  // Mobile reaction UI is now provided by ReactionsRail.
  // The mobile branch here is muted; useEffect subscribers above
  // continue to run for any global side effects (logging, metrics,
  // legacy float fallback for pid-less desktop senders).
  if (isMobile) {
    return null;
  }

  // ---- Desktop layout ----
  // One 😊 button; clicking it opens the reactions above it, clicking it
  // again closes them (as do Escape and a click elsewhere). Always open,
  // the column covered the side panels (owner, 2026-10-26).
  return (
    <>
      {floatOverlay}
      <DesktopPicker onSend={send} />
      {keyframes}
    </>
  );
}

function DesktopPicker({ onSend }: { onSend: (k: ReactionKey) => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={boxRef}
      style={{
        position: 'fixed',
        right: 18,
        bottom: '18%',
        zIndex: 70,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {open && (
        <div
          id="neo-reactions-menu"
          role="menu"
          aria-label="Reactions"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 8,
            borderRadius: 14,
            background: 'rgba(15,23,42,0.55)',
            border: '1px solid rgba(34,211,238,0.25)',
            backdropFilter: 'blur(12px)',
          }}
        >
          {REACTIONS.map((k) => (
            <button
              key={k}
              type="button"
              role="menuitem"
              aria-label={`Send ${k}`}
              onClick={() => onSend(k)}
              style={{
                fontSize: '22px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                width: 36,
                height: 36,
                borderRadius: 10,
              }}
            >
              {EMOJI[k]}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        aria-label={open ? 'Close reactions' : 'Open reactions'}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? 'neo-reactions-menu' : undefined}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          fontSize: open ? 18 : 22,
          color: '#cbd5e1',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(15,23,42,0.75)',
          border: '1px solid rgba(34,211,238,0.25)',
          boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
          backdropFilter: 'blur(12px)',
        }}
      >
        {open ? '✕' : '😊'}
      </button>
    </div>
  );
}
