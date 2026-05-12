'use client';
import { zIndex } from "@/lib/zIndex";

// src/components/ReactionsBar.tsx
//
// World-class floating emoji reactions for the live LiveKit room.
// Sends + receives via DataChannel (lossy) so it works without any
// backend persistence. Renders ephemeral floating emoji that drift up
// and fade. Place inside <LiveKitRoom> tree.
//
// World-class details:
// - Local send rate-limit (400ms) prevents spam from the local user.
// - Per-sender remote rate-limit (800ms) absorbs noisy peers without
//   dropping the channel.
// - Remote reactions show a short sender label ("Alice 👏") under
//   the floating emoji for Zoom/Meet parity.
// - Respects prefers-reduced-motion: replaces the float with a
//   gentle fade so vestibular-sensitive users are not disturbed.
// - aria-live="polite" announcer for screen readers.
// - Particle cap (60) to keep the DOM honest under heavy use.
// - Per-particle x-jitter + duration variance for natural motion.
//
// Layout:
// - Desktop (>640px): vertical stack of reaction buttons floating on
//   the right edge of the video area.
// - Mobile (<=640px): single trigger button anchored bottom-right
//   above the mobile control bar. Tapping opens a compact horizontal
//   row of reactions that auto-closes on selection / outside tap.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';

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

type Floating = {
  id: string;
  emoji: string;
  left: number;
  durationMs: number;
  rise: number;
  drift: number;
  senderLabel?: string;
};

const TOPIC = 'neo-reactions';
const LOCAL_THROTTLE_MS = 400;
const REMOTE_THROTTLE_MS = 800;
const MAX_FLOATS = 60;

// Friendly name from an opaque participant identity / metadata.
// Falls back gracefully so we never render "undefined reacted".
function deriveSenderLabel(p: any): string | undefined {
  if (!p) return undefined;
  const name = (p.name as string | undefined) || undefined;
  if (name && name.trim()) return name.trim();
  try {
    const meta = p.metadata ? JSON.parse(p.metadata) : null;
    const mName = meta && typeof meta.name === "string" ? meta.name.trim() : "";
    if (mName) return mName;
  } catch {}
  const id = (p.identity as string | undefined) || undefined;
  if (id && id.trim()) return id.trim();
  return undefined;
}

export default function ReactionsBar() {
  const room = useRoomContext();
  const [floats, setFloats] = useState<Floating[]>([]);
  const [isMobile, setIsMobile] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [announce, setAnnounce] = useState('');
  const idRef = useRef(0);
  const lastLocalSendRef = useRef(0);
  const lastRemoteBySenderRef = useRef<Record<string, number>>({});

  // Track mobile breakpoint via matchMedia so we react to rotation / resize.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 640px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Honour prefers-reduced-motion so vestibular-sensitive users get a
  // calm fade instead of an upward float.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReducedMotion(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Close the mobile picker if the viewport leaves mobile mode mid-session.
  useEffect(() => {
    if (!isMobile) setPickerOpen(false);
  }, [isMobile]);

  const spawn = useCallback((emoji: string, senderLabel?: string) => {
    const id = `r-${++idRef.current}`;
    // Bias left position toward middle 80% of overlay so the emoji never
    // clip into the toolbar / chrome on the edges.
    const left = 10 + Math.random() * 80;
    const durationMs = 2200 + Math.floor(Math.random() * 800);
    const rise = 220 + Math.floor(Math.random() * 80);
    const drift = Math.round((Math.random() * 80) - 40);
    setFloats((arr) => {
      const next = [...arr, { id, emoji, left, durationMs, rise, drift, senderLabel }];
      // Cap concurrent particles so a hostile / chatty room cannot blow
      // out the DOM. We drop the oldest first (queue semantics).
      return next.length > MAX_FLOATS ? next.slice(next.length - MAX_FLOATS) : next;
    });
    setTimeout(() => {
      setFloats((arr) => arr.filter((f) => f.id !== id));
    }, durationMs);
  }, []);

  // Receive remote reactions. We accept any handler arity because LiveKit
  // has shipped slightly different signatures over time; positional args
  // (payload, participant, kind, topic) cover the historical surface.
  useEffect(() => {
    if (!room) return;
    const dec = new TextDecoder();
    const handler = (payload: Uint8Array, participant?: any, _kind?: any, topic?: string) => {
      if (topic && topic !== TOPIC) return;
      try {
        const msg = JSON.parse(dec.decode(payload));
        if (!msg || typeof msg.k !== 'string') return;
        const k = msg.k as ReactionKey;
        if (!EMOJI[k]) return;
        // Per-sender throttle: 1 emoji per REMOTE_THROTTLE_MS per peer.
        const senderId = (participant && participant.identity) || 'unknown';
        const now = Date.now();
        const last = lastRemoteBySenderRef.current[senderId] || 0;
        if (now - last < REMOTE_THROTTLE_MS) return;
        lastRemoteBySenderRef.current[senderId] = now;
        const label = deriveSenderLabel(participant);
        spawn(EMOJI[k], label);
        if (label) setAnnounce(`${label} reacted ${k}`);
        else setAnnounce(`Someone reacted ${k}`);
      } catch {}
    };
    room.on(RoomEvent.DataReceived, handler as any);
    return () => { room.off(RoomEvent.DataReceived, handler as any); };
  }, [room, spawn]);

  const send = useCallback(async (k: ReactionKey) => {
    // Local throttle: protect peers from a stuck button / impatient user.
    const now = Date.now();
    if (now - lastLocalSendRef.current < LOCAL_THROTTLE_MS) return;
    lastLocalSendRef.current = now;
    // Optimistic local spawn so the sender sees instant feedback.
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
        zIndex: zIndex.panel,
        overflow: 'hidden',
      }}
    >
      {floats.map((f) => (
        <div
          key={f.id}
          style={{
            position: 'absolute',
            bottom: '12%',
            left: `${f.left}%`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            // Custom-property driven keyframe so each particle gets its
            // own rise distance + horizontal drift without a per-particle
            // <style> tag.
            ['--neo-rise' as any]: `${-f.rise}px`,
            ['--neo-drift' as any]: `${f.drift}px`,
            animation: reducedMotion
              ? `neoReactFade ${Math.max(1200, f.durationMs)}ms ease-out forwards`
              : `neoReactFloat ${f.durationMs}ms cubic-bezier(0.22, 1, 0.36, 1) forwards`,
            willChange: 'transform, opacity',
          }}
        >
          <span style={{ fontSize: '32px', lineHeight: 1, filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.45))' }}>
            {f.emoji}
          </span>
          {f.senderLabel && (
            <span
              style={{
                fontSize: '11px',
                color: 'rgba(255,255,255,0.92)',
                background: 'rgba(15,23,42,0.72)',
                padding: '2px 8px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.12)',
                maxWidth: 160,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                fontWeight: 500,
              }}
            >
              {f.senderLabel}
            </span>
          )}
        </div>
      ))}
    </div>
  );

  // Live region for screen readers. Polite so it never interrupts speech.
  const liveRegion = (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: 'fixed',
        width: 1,
        height: 1,
        margin: -1,
        padding: 0,
        overflow: 'hidden',
        clip: 'rect(0 0 0 0)',
        whiteSpace: 'nowrap',
        border: 0,
      }}
    >
      {announce}
    </div>
  );

  const keyframes = (
    <style>{`
@keyframes neoReactFloat {
  0%   { transform: translate3d(0, 0, 0) scale(0.6); opacity: 0; }
  15%  { transform: translate3d(calc(var(--neo-drift) * 0.2), calc(var(--neo-rise) * 0.1), 0) scale(1); opacity: 1; }
  100% { transform: translate3d(var(--neo-drift), var(--neo-rise), 0) scale(1.15); opacity: 0; }
}
@keyframes neoReactFade {
  0%   { opacity: 0; transform: scale(0.85); }
  20%  { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1); }
}
`}</style>
  );

  // ---- Mobile layout: single trigger + expandable row above control bar ----
  if (isMobile) {
    return (
      <>
        {floatOverlay}
        {liveRegion}
        {pickerOpen && (
          <div
            aria-hidden
            onClick={() => setPickerOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: zIndex.panel,
              background: 'transparent',
            }}
          />
        )}
        <div
          style={{
            position: 'fixed',
            right: 12,
            bottom: 84,
            zIndex: zIndex.panel,
            display: 'flex',
            flexDirection: 'row-reverse',
            alignItems: 'center',
            gap: 8,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label={pickerOpen ? 'Close reactions' : 'Open reactions'}
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((v) => !v)}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              background: 'rgba(15,23,42,0.85)',
              border: '1px solid rgba(34,211,238,0.35)',
              backdropFilter: 'blur(12px)',
              color: '#fff',
              fontSize: 22,
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            }}
          >
            {pickerOpen ? '✕' : '😊'}
          </button>
          {pickerOpen && (
            <div
              role="group"
              aria-label="Reactions"
              style={{
                display: 'flex',
                flexDirection: 'row',
                gap: 4,
                padding: 6,
                borderRadius: 28,
                background: 'rgba(15,23,42,0.92)',
                border: '1px solid rgba(34,211,238,0.3)',
                backdropFilter: 'blur(12px)',
                boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
              }}
            >
              {REACTIONS.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-label={`Send ${k}`}
                  onClick={() => send(k)}
                  style={{
                    fontSize: '22px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    padding: 0,
                  }}
                >
                  {EMOJI[k]}
                </button>
              ))}
            </div>
          )}
        </div>
        {keyframes}
      </>
    );
  }

  // ---- Desktop layout ----
  return (
    <>
      {floatOverlay}
      {liveRegion}
      <div
        role="group"
        aria-label="Reactions"
        style={{
          position: 'fixed',
          right: 18,
          bottom: '18%',
          zIndex: zIndex.panelRaised,
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
            aria-label={`Send ${k}`}
            onClick={() => send(k)}
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
      {keyframes}
    </>
  );
}
