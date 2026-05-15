'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useRoomContext, useLocalParticipant } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { useMediaQuery } from '@/hooks/useIsMobile';

/* ------------------------------------------------------------------ */
/*  Constants & types                                                  */
/* ------------------------------------------------------------------ */

const REACTIONS = ['heart', 'thumbs', 'clap', 'laugh', 'wow', 'fire'] as const;
type ReactionKey = (typeof REACTIONS)[number];

const EMOJI: Record<ReactionKey, string> = {
  heart: '❤️',
  thumbs: '👍',
  clap: '👏',
  laugh: '😂',
  wow: '😮',
  fire: '🔥',
};

const EMOJI_LABELS: Record<ReactionKey, string> = {
  heart: 'React with heart',
  thumbs: 'React with thumbs up',
  clap: 'React with clap',
  laugh: 'React with laugh',
  wow: 'React with surprise',
  fire: 'React with fire',
};

type ReactionPayload = { k: ReactionKey; pid?: string };

const REACTION_TOPIC = 'neo-reactions';
const HAND_TOPIC = 'neo-hand';

const SEND_THROTTLE_MS = 500;
const AUTO_COLLAPSE_MS = 4000;
const TAP_COLLAPSE_MS = 200;

function isReactionKey(v: unknown): v is ReactionKey {
  return typeof v === 'string' && (REACTIONS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------ */
/*  Motion variants                                                    */
/* ------------------------------------------------------------------ */

const capsuleVariants = {
  hidden: { scale: 0.3, y: 20, opacity: 0 },
  visible: { scale: 1, y: 0, opacity: 1 },
  exit: { scale: 0.3, y: 20, opacity: 0 },
};
const capsuleTransition = { duration: 0.35, ease: [0.34, 1.56, 0.64, 1] as const };

const capsuleReducedVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};
const capsuleReducedTransition = { duration: 0.15, ease: 'easeOut' as const };

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ReactionsRail() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const prefersReduced = useMediaQuery('(prefers-reduced-motion: reduce)');

  /* ---- state ---- */
  const [isOpen, setIsOpen] = useState(false);
  const [localHandRaised, setLocalHandRaised] = useState(false);

  const lastSendAt = useRef(0);
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstEmojiRef = useRef<HTMLButtonElement>(null);

  /* ---- helpers ---- */
  const clearInactivity = useCallback(() => {
    if (inactivityTimer.current) {
      clearTimeout(inactivityTimer.current);
      inactivityTimer.current = null;
    }
  }, []);

  const resetInactivity = useCallback(() => {
    clearInactivity();
    inactivityTimer.current = setTimeout(() => setIsOpen(false), AUTO_COLLAPSE_MS);
  }, [clearInactivity]);

  /* ---- neo-reactions receiver ---- */
  useEffect(() => {
    if (!room) return;
    const dec = new TextDecoder();
    const handler = (payload: Uint8Array, _p: unknown, _k: unknown, topic?: string) => {
      if (topic && topic !== REACTION_TOPIC) return;
      try {
        const msg = JSON.parse(dec.decode(payload)) as Record<string, unknown>;
        if (!isReactionKey(msg.k)) return;
        const pid = typeof msg.pid === 'string' ? msg.pid : undefined;
        // Skip self — optimistic dispatch already handled
        if (pid && pid === localParticipant?.identity) return;
        if (pid) {
          window.dispatchEvent(
            new CustomEvent('neo-reaction-burst', { detail: { pid, emoji: EMOJI[msg.k] } }),
          );
        }
        // If pid is absent (legacy desktop sender), no per-tile dispatch on mobile.
      } catch { /* malformed payload — ignore */ }
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => { room.off(RoomEvent.DataReceived, handler); };
  }, [room, localParticipant?.identity]);

  /* ---- neo-hand receiver (mirror local state) ---- */
  useEffect(() => {
    if (!room || !localParticipant) return;
    const dec = new TextDecoder();
    const handler = (payload: Uint8Array, _p: unknown, _k: unknown, topic?: string) => {
      if (topic && topic !== HAND_TOPIC) return;
      try {
        const msg = JSON.parse(dec.decode(payload)) as Record<string, unknown>;
        if (typeof msg.id !== 'string') return;
        if (msg.id === localParticipant.identity || msg.id === localParticipant.sid) {
          setLocalHandRaised(!!msg.on);
        }
      } catch { /* ignore */ }
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => { room.off(RoomEvent.DataReceived, handler); };
  }, [room, localParticipant]);

  /* ---- send reaction ---- */
  const sendReaction = useCallback(
    (k: ReactionKey) => {
      if (!localParticipant) return;
      const now = Date.now();
      if (now - lastSendAt.current < SEND_THROTTLE_MS) return;
      lastSendAt.current = now;

      const pid = localParticipant.identity;
      const payload: ReactionPayload = { k, pid };

      // Optimistic local burst
      window.dispatchEvent(
        new CustomEvent('neo-reaction-burst', { detail: { pid, emoji: EMOJI[k] } }),
      );

      try {
        const data = new TextEncoder().encode(JSON.stringify(payload));
        localParticipant.publishData(data, { reliable: false, topic: REACTION_TOPIC });
      } catch { /* best effort */ }

      // Auto-collapse after tap
      setTimeout(() => setIsOpen(false), TAP_COLLAPSE_MS);
    },
    [localParticipant],
  );

  /* ---- toggle hand ---- */
  const toggleHand = useCallback(() => {
    if (!localParticipant) return;
    const next = !localHandRaised;
    setLocalHandRaised(next);
    resetInactivity(); // hand tap resets inactivity but doesn't collapse

    const id = localParticipant.identity || localParticipant.sid;
    const name = localParticipant.name || localParticipant.identity || 'Guest';
    try {
      const data = new TextEncoder().encode(
        JSON.stringify({ id, name, on: next, ts: Date.now() }),
      );
      localParticipant.publishData(data, { reliable: true, topic: HAND_TOPIC });
    } catch { /* best effort */ }
  }, [localParticipant, localHandRaised, resetInactivity]);

  /* ---- open / close ---- */
  const open = useCallback(() => {
    setIsOpen(true);
    resetInactivity();
  }, [resetInactivity]);

  const close = useCallback(() => {
    setIsOpen(false);
    clearInactivity();
  }, [clearInactivity]);

  /* ---- focus management ---- */
  useEffect(() => {
    if (isOpen) {
      // Delay to let AnimatePresence mount
      const t = setTimeout(() => firstEmojiRef.current?.focus(), 50);
      return () => clearTimeout(t);
    } else {
      triggerRef.current?.focus();
    }
  }, [isOpen]);

  /* ---- click outside ---- */
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: PointerEvent) => {
      if (railRef.current && !railRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [isOpen, close]);

  /* ---- Escape ---- */
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, close]);

  /* ---- inactivity on open ---- */
  useEffect(() => {
    if (isOpen) {
      resetInactivity();
    } else {
      clearInactivity();
    }
    return clearInactivity;
  }, [isOpen, resetInactivity, clearInactivity]);

  /* ---- motion config ---- */
  const variants = prefersReduced ? capsuleReducedVariants : capsuleVariants;
  const transition = prefersReduced ? capsuleReducedTransition : capsuleTransition;

  /* ---- collapsed trigger styles ---- */
  const triggerStyle: React.CSSProperties = localHandRaised
    ? {
        width: 38,
        height: 38,
        borderRadius: '50%',
        background: 'rgba(245,158,11,0.2)',
        border: '0.5px solid rgba(245,158,11,0.6)',
        boxShadow: '0 0 12px rgba(245,158,11,0.4)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        fontSize: 18,
        cursor: 'pointer',
        padding: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }
    : {
        width: 38,
        height: 38,
        borderRadius: '50%',
        background: 'rgba(0,0,0,0.6)',
        border: '0.5px solid rgba(255,255,255,0.12)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        fontSize: 18,
        cursor: 'pointer',
        padding: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      };

  /* ---- render ---- */
  return (
    <div ref={railRef} className="absolute bottom-4 right-3 z-10">
      <AnimatePresence mode="wait">
        {isOpen ? (
          <motion.div
            key="capsule"
            role="menu"
            aria-label="Reactions"
            variants={variants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={transition}
            className="flex flex-col items-center rounded-full"
            style={{
              background: 'rgba(0,0,0,0.6)',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              border: '0.5px solid rgba(255,255,255,0.12)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              padding: '6px 4px',
              gap: 8,
              transformOrigin: 'bottom right',
            }}
          >
            {/* Emoji buttons */}
            {REACTIONS.map((k, i) => (
              <button
                key={k}
                ref={i === 0 ? firstEmojiRef : undefined}
                type="button"
                role="menuitem"
                aria-label={EMOJI_LABELS[k]}
                onClick={() => {
                  sendReaction(k);
                  resetInactivity();
                }}
                className="text-base"
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {EMOJI[k]}
              </button>
            ))}

            {/* Divider */}
            <div className="w-full h-px bg-white/15 my-0.5" />

            {/* Raise hand */}
            <button
              type="button"
              role="menuitem"
              aria-label={localHandRaised ? 'Lower hand' : 'Raise hand'}
              aria-pressed={localHandRaised}
              onClick={toggleHand}
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                fontSize: 13,
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: localHandRaised ? 'rgba(245,158,11,0.2)' : 'transparent',
                border: localHandRaised ? '0.5px solid rgba(245,158,11,0.6)' : 'none',
                boxShadow: localHandRaised ? '0 0 10px rgba(245,158,11,0.4)' : 'none',
              }}
            >
              ✋
            </button>

            {/* Divider */}
            <div className="w-full h-px bg-white/15 my-0.5" />

            {/* Close */}
            <button
              type="button"
              role="menuitem"
              aria-label="Close reactions"
              onClick={close}
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.06)',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X className="w-3 h-3 text-zinc-400" />
            </button>
          </motion.div>
        ) : (
          <motion.button
            key="trigger"
            ref={triggerRef}
            type="button"
            aria-label={isOpen ? 'Close reactions' : 'Open reactions'}
            aria-expanded={isOpen}
            aria-haspopup="menu"
            onClick={open}
            style={triggerStyle}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {localHandRaised ? '✋' : '😊'}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
