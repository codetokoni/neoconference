'use client';

// src/components/RaiseHandButton.tsx
//
// Floating raise-hand button for attendees + a roster popover for hosts.
// Uses LiveKit DataChannel topic "neo-hand" with payload { id, name, on, ts }.
// Each participant tracks their own state; hosts see all currently-raised hands.
//
// On-tile pill is rendered via React portals (NOT a CSS ::after) so it can
// animate both in AND out smoothly when participants toggle their hand.

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useRoomContext, useParticipants } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';

const TOPIC = 'neo-hand';
const EXIT_MS = 260;

type Hand = { id: string; name: string; raisedAt: number };
type Props = { isHost?: boolean };

export default function RaiseHandButton({ isHost = false }: Props) {
  const room = useRoomContext();
  const participants = useParticipants();
  const [raised, setRaised] = useState(false);
  const [hands, setHands] = useState<Map<string, Hand>>(new Map());
  const [leaving, setLeaving] = useState<Map<string, Hand>>(new Map());
  const [showRoster, setShowRoster] = useState(false);
  const [, setTick] = useState(0);
  const handsRef = useRef(hands);
  handsRef.current = hands;

  useEffect(() => {
    if (!room) return;
    const dec = new TextDecoder();
    const handler = (payload: Uint8Array, _p: any, _k: any, topic?: string) => {
      if (topic && topic !== TOPIC) return;
      try {
        const m = JSON.parse(dec.decode(payload));
        if (!m || typeof m.id !== 'string') return;
        setHands((prev) => {
          const next = new Map(prev);
          if (m.on) next.set(m.id, { id: m.id, name: String(m.name || 'Guest'), raisedAt: Number(m.ts) || Date.now() });
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
    const name = me.name || me.identity || 'Guest';
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

  // Track hands that were just removed so we can animate them out.
  const prevHandsRef = useRef<Map<string, Hand>>(new Map());
  useEffect(() => {
    const prev = prevHandsRef.current;
    const dropped: Hand[] = [];
    prev.forEach((h, id) => { if (!hands.has(id)) dropped.push(h); });
    if (dropped.length) {
      setLeaving((cur) => {
        const m = new Map(cur);
        for (const h of dropped) m.set(h.id, h);
        return m;
      });
      const timers = dropped.map((h) =>
        window.setTimeout(() => {
          setLeaving((cur) => {
            if (!cur.has(h.id)) return cur;
            const m = new Map(cur);
            m.delete(h.id);
            return m;
          });
        }, EXIT_MS),
      );
      prevHandsRef.current = new Map(hands);
      return () => { for (const t of timers) window.clearTimeout(t); };
    }
    prevHandsRef.current = new Map(hands);
  }, [hands]);

  // If a hand is re-raised while still in exit, drop it from leaving.
  useEffect(() => {
    if (leaving.size === 0) return;
    let mutated: Map<string, Hand> | null = null;
    leaving.forEach((_h, id) => {
      if (hands.has(id)) {
        if (!mutated) mutated = new Map(leaving);
        mutated!.delete(id);
      }
    });
    if (mutated) setLeaving(mutated);
  }, [hands, leaving]);

  // Tick so portals catch tile DOM that mounts late.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1000000), 800);
    return () => clearInterval(id);
  }, []);

  const resolveTile = (identity: string): HTMLElement | null => {
    if (typeof document === 'undefined') return null;
    const p = participants.find((pp) => pp.identity === identity);
    const displayName = (p?.name && p.name.length > 0 ? p.name : p?.identity) || '';
    if (!displayName) return null;
    const tiles = document.querySelectorAll<HTMLElement>('.lk-participant-tile');
    for (const t of Array.from(tiles)) {
      const nameEl = t.querySelector<HTMLElement>('.lk-participant-name');
      const raw = (nameEl?.textContent || '').trim();
      if (raw === displayName) return t;
    }
    return null;
  };

  const portalItems: Array<{ key: string; target: HTMLElement; state: 'in' | 'out' }> = [];
  hands.forEach((h) => {
    const t = resolveTile(h.id);
    if (t) portalItems.push({ key: h.id, target: t, state: 'in' });
  });
  leaving.forEach((h) => {
    if (hands.has(h.id)) return;
    const t = resolveTile(h.id);
    if (t) portalItems.push({ key: 'leave-' + h.id, target: t, state: 'out' });
  });

  const handCount = hands.size;
  return (
    <>
      <style>{`
        .neo-hand-pill {
          position: absolute;
          top: 8px;
          left: 8px;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 20px;
          background: #fbbf24;
          color: #0e1530;
          border-radius: 50%;
          z-index: 5;
          pointer-events: none;
          transform-origin: 50% 50%;
          will-change: transform, opacity, box-shadow;
        }
        .neo-hand-pill--in {
          animation: neo-hand-in 240ms cubic-bezier(0.22, 1, 0.36, 1) both,
            neo-hand-pulse 1.8s ease-in-out 240ms infinite;
        }
        .neo-hand-pill--out {
          animation: neo-hand-out 260ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
        }
        @keyframes neo-hand-in {
          0%   { transform: scale(0.4); opacity: 0; box-shadow: 0 0 0 rgba(251,191,36,0); }
          70%  { transform: scale(1.12); opacity: 1; }
          100% { transform: scale(1); opacity: 1; box-shadow: 0 0 16px rgba(251,191,36,0.7); }
        }
        @keyframes neo-hand-out {
          0%   { transform: scale(1); opacity: 1; box-shadow: 0 0 16px rgba(251,191,36,0.7); }
          100% { transform: scale(0.55); opacity: 0; box-shadow: 0 0 0 rgba(251,191,36,0); }
        }
        @keyframes neo-hand-pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 12px rgba(251,191,36,0.55); }
          50%      { transform: scale(1.06); box-shadow: 0 0 22px rgba(251,191,36,0.95); }
        }
        .neo-raise-btn {
          transition: background-color 220ms ease, color 220ms ease,
            box-shadow 260ms ease, border-color 220ms ease, transform 140ms ease;
        }
        .neo-raise-btn:hover  { transform: translateY(-1px); }
        .neo-raise-btn:active { transform: scale(0.94); }
        .neo-raise-btn[aria-pressed="true"] {
          animation: neo-raise-glow 2.4s ease-in-out infinite;
        }
        @keyframes neo-raise-glow {
          0%, 100% { box-shadow: 0 0 16px rgba(251,191,36,0.45); }
          50%      { box-shadow: 0 0 28px rgba(251,191,36,0.85); }
        }
      `}</style>

      {portalItems.map((it) =>
        createPortal(
          <span
            className={'neo-hand-pill neo-hand-pill--' + it.state}
            aria-hidden
          >
            ✋
          </span>,
          it.target,
          'neo-hand-pill-' + it.key,
        ),
      )}

      <button
        type="button"
        className="neo-raise-btn"
        onClick={toggle}
        aria-pressed={raised}
        title={raised ? 'Lower hand' : 'Raise hand'}
        style={{
          position: 'fixed',
          bottom: 90,
          right: 18,
          zIndex: 70,
          width: 44,
          height: 44,
          borderRadius: 22,
          fontSize: 22,
          backgroundColor: raised ? '#fbbf24' : 'rgba(15,23,42,0.7)',
          color: raised ? '#0e1530' : '#fbbf24',
          border: '1px solid ' + (raised ? 'rgba(251,191,36,0.85)' : 'rgba(251,191,36,0.4)'),
          cursor: 'pointer',
          backdropFilter: 'blur(10px)',
          boxShadow: raised ? '0 0 24px rgba(251,191,36,0.55)' : '0 0 0 rgba(251,191,36,0)',
        }}
      >
        ✋
      </button>

      {isHost && handCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowRoster((v) => !v)}
          style={{ position: 'fixed', bottom: 90, right: 72, zIndex: 70, padding: '6px 12px', borderRadius: 16, background: '#fbbf24', color: '#0e1530', border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
        >
          {handCount} hand{handCount === 1 ? '' : 's'}
        </button>
      ) : null}

      {isHost && showRoster ? (
        <div
          style={{ position: 'fixed', bottom: 140, right: 18, zIndex: 70, width: 240, maxHeight: 320, overflowY: 'auto', padding: 12, borderRadius: 12, background: 'rgba(8,11,20,0.92)', border: '1px solid rgba(251,191,36,0.35)', color: '#e2e8f0', backdropFilter: 'blur(14px)' }}
        >
          <p style={{ margin: 0, fontSize: 11, letterSpacing: 1.4, color: '#fbbf24', textTransform: 'uppercase' }}>Raised hands</p>
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[...hands.values()].sort((a,b) => a.raisedAt - b.raisedAt).map((h) => (
              <li key={h.id} style={{ fontSize: 13, padding: '6px 8px', borderRadius: 8, background: 'rgba(251,191,36,0.08)' }}>
                <span style={{ marginRight: 6 }}>✋</span>{h.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
