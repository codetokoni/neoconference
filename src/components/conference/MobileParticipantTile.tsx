'use client';

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { motion } from 'framer-motion';
import { MicOff } from 'lucide-react';
import { Track, type Participant } from 'livekit-client';
import { useIsSpeaking, VideoTrack } from '@livekit/components-react';
import {
  getAvatarColor,
  getAvatarColorRGB,
  getInitials,
} from '@/lib/avatarColor';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MobileParticipantTileProps {
  participant: Participant;
  localIsHost: boolean;
  participantIsHost: boolean;
  slug: string;
  onSpotlight?: (participantId: string) => void;
  isVisible?: boolean;
  aspect?: 'square' | 'video';
}

interface ReactionBurst {
  id: string;
  emoji: string;
  ts: number;
}

/* ------------------------------------------------------------------ */
/*  CSS keyframes (injected once)                                      */
/* ------------------------------------------------------------------ */

const KEYFRAMES_ID = '__mobile-tile-burst-kf';

function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = KEYFRAMES_ID;
  style.textContent = `
@keyframes mobile-burst {
  0%   { transform: translateY(0) scale(1); opacity: 1; }
  100% { transform: translateY(-24px) scale(1.3); opacity: 0; }
}
@keyframes mobile-burst-reduced {
  0%   { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes mobile-speak-dot {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}
`;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_BURSTS = 3;
const BURST_DURATION = 2500;

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

function MobileParticipantTileInner({
  participant,
  localIsHost,
  participantIsHost,
  slug,
  onSpotlight,
  isVisible = true,
  aspect = 'square',
}: MobileParticipantTileProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const isSpeaking = useIsSpeaking(participant);

  const seed = participant.name || participant.identity;
  const displayName = participant.name || participant.identity;
  const avatarHex = getAvatarColor(seed);
  const avatarRGB = getAvatarColorRGB(seed);
  const initials = getInitials(seed);

  /* ---------- camera track detection ---------- */
  const camPub = participant.getTrackPublication(Track.Source.Camera);
  const hasCam = !!(camPub?.isSubscribed && !camPub.isMuted);

  /* ---------- host menu (long press) ---------- */
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);

  const clearPress = useCallback(() => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressOrigin.current = null;
  }, []);

  const handleModerate = useCallback(
    async (action: 'muteAudio' | 'muteVideo' | 'kick') => {
      setMenuError(null);
      setPending(action);
      try {
        const r = await fetch('/api/livekit/moderate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, action, participantIdentity: participant.identity }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setMenuError(j.error || 'request_failed');
          return;
        }
        setMenuOpen(false);
      } catch (e) {
        setMenuError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(null);
      }
    },
    [slug, participant.identity],
  );

  /* ---------- double-tap → spotlight ---------- */
  const lastTap = useRef(0);

  const handleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      // double-tap
      if (localIsHost && rootRef.current) {
        rootRef.current.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        onSpotlight?.(participant.identity);
      }
      lastTap.current = 0;
    } else {
      lastTap.current = now;
    }
  }, [localIsHost, onSpotlight, participant.identity]);

  /* ---------- pointer handlers (long press + tap) ---------- */
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      pressOrigin.current = { x: e.clientX, y: e.clientY };
      if (localIsHost) {
        pressTimer.current = setTimeout(() => {
          setMenuOpen(true);
          pressTimer.current = null;
        }, 500);
      }
    },
    [localIsHost],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!pressOrigin.current) return;
      const dx = e.clientX - pressOrigin.current.x;
      const dy = e.clientY - pressOrigin.current.y;
      if (dx * dx + dy * dy > 100) clearPress(); // 10px threshold squared
    },
    [clearPress],
  );

  const onPointerUp = useCallback(() => {
    if (pressTimer.current) {
      // released before 500ms — treat as tap
      clearPress();
      if (!menuOpen) handleTap();
    } else {
      clearPress();
    }
  }, [clearPress, handleTap, menuOpen]);

  const onPointerCancel = useCallback(() => clearPress(), [clearPress]);

  /* ---------- close menu on outside tap / Escape ---------- */
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onClick, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onClick, true);
    };
  }, [menuOpen]);

  /* ---------- reaction bursts ---------- */
  const [bursts, setBursts] = useState<ReactionBurst[]>([]);
  const burstId = useRef(0);

  useEffect(() => {
    ensureKeyframes();
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ pid: string; emoji: string }>).detail;
      if (detail.pid !== participant.identity) return;
      const id = String(++burstId.current);
      setBursts((prev) => {
        const next = [...prev, { id, emoji: detail.emoji, ts: Date.now() }];
        return next.length > MAX_BURSTS ? next.slice(next.length - MAX_BURSTS) : next;
      });
      setTimeout(() => {
        setBursts((prev) => prev.filter((b) => b.id !== id));
      }, BURST_DURATION);
    };
    window.addEventListener('neo-reaction-burst', handler);
    return () => window.removeEventListener('neo-reaction-burst', handler);
  }, [participant.identity, isVisible]);

  /* ---------- styles ---------- */
  const glowAlpha = isSpeaking ? 0.12 : 0.06;

  const rootStyle: React.CSSProperties = {
    backgroundImage: isSpeaking
      ? 'linear-gradient(180deg, rgba(8,47,73,0.4) 0%, rgba(9,9,11,0.9) 100%)'
      : 'linear-gradient(180deg, rgba(24,24,27,0.7) 0%, rgba(9,9,11,0.9) 100%)',
    border: isSpeaking ? '1px solid #22d3ee' : '0.5px solid rgba(255,255,255,0.06)',
    boxShadow: isSpeaking
      ? '0 0 16px rgba(34,211,238,0.3), inset 0 0 24px rgba(34,211,238,0.05)'
      : 'none',
    touchAction: 'manipulation',
    transition: 'border 200ms ease-out, background-image 200ms ease-out, box-shadow 200ms ease-out',
  };

  const pillBorder = isSpeaking
    ? '0.5px solid rgba(34,211,238,0.3)'
    : '0.5px solid rgba(255,255,255,0.06)';

  /* ---------- render ---------- */
  return (
    <motion.div
      ref={rootRef}
      layout
      className={`lk-participant-tile ${aspect === 'video' ? 'aspect-video' : 'aspect-square'} rounded-xl overflow-hidden relative`}
      style={rootStyle}
      data-lk-participant-identity={participant.identity}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {/* Radial glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(circle at center, rgba(${avatarRGB}, ${glowAlpha}) 0%, transparent 60%)`,
          transition: 'background 200ms ease-out',
        }}
      />

      {/* Camera or Avatar */}
      {hasCam && camPub?.videoTrack ? (
        <VideoTrack
          trackRef={{
            participant,
            publication: camPub,
            source: Track.Source.Camera,
          }}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center"
            style={{
              background: avatarHex,
              boxShadow: `0 4px 16px rgba(${avatarRGB}, 0.25)`,
            }}
          >
            <span className="text-base font-medium text-white">{initials}</span>
          </div>
        </div>
      )}

      {/* Reaction bursts */}
      {bursts.map((b, i) => (
        <span
          key={b.id}
          className="absolute pointer-events-none text-lg"
          style={{
            top: 4,
            left: 4,
            animationName: 'mobile-burst, mobile-burst-reduced',
            animationDuration: `${BURST_DURATION}ms`,
            animationTimingFunction: 'ease-out',
            animationFillMode: 'forwards',
            animationDelay: `${i * 200}ms`,
          }}
        >
          {b.emoji}
        </span>
      ))}

      {/* Name pill */}
      <div
        className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center gap-1 rounded-full px-1.5 py-0.5"
        style={{
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: pillBorder,
          transition: 'border 200ms ease-out',
        }}
      >
        {/* Mic-off icon OR speaking dot */}
        {!participant.isMicrophoneEnabled ? (
          <MicOff className="w-2.5 h-2.5 text-red-400 shrink-0" />
        ) : isSpeaking ? (
          <span
            className="shrink-0 rounded-full bg-cyan-400"
            style={{
              width: 6,
              height: 6,
              boxShadow: '0 0 6px rgba(34,211,238,0.6)',
              animationName: 'mobile-speak-dot',
              animationDuration: '1.2s',
              animationIterationCount: 'infinite',
              animationTimingFunction: 'ease-in-out',
            }}
          />
        ) : null}

        {/* Host badge */}
        {participantIsHost && (
          <span
            className="shrink-0 font-medium text-cyan-400"
            style={{
              fontSize: 7,
              lineHeight: 1,
              border: '0.5px solid rgba(34,211,238,0.5)',
              borderRadius: 2,
              padding: '1px 2px',
            }}
          >
            HOST
          </span>
        )}

        {/* Name */}
        <span className="lk-participant-name text-white truncate" style={{ fontSize: 10 }}>
          {displayName}
        </span>
      </div>

      {/* Host action menu (long-press) */}
      {menuOpen && localIsHost && (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5"
          style={{
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            transition: 'opacity 150ms ease-out',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuBtn
            label="Mute"
            disabled={pending !== null}
            loading={pending === 'muteAudio'}
            onClick={() => handleModerate('muteAudio')}
          />
          {/* TODO: lower hand — blocked on neo-hand → metadata migration */}
          <MenuBtn
            label="Remove"
            danger
            disabled={pending !== null}
            loading={pending === 'kick'}
            onClick={() => handleModerate('kick')}
          />
          {menuError && (
            <span className="text-red-400" style={{ fontSize: 9 }}>
              {menuError}
            </span>
          )}
          <button
            type="button"
            className="text-white/50 mt-1"
            style={{ fontSize: 10, background: 'none', border: 'none' }}
            onClick={() => setMenuOpen(false)}
          >
            Cancel
          </button>
        </div>
      )}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Menu button (internal)                                             */
/* ------------------------------------------------------------------ */

function MenuBtn({
  label,
  onClick,
  disabled,
  loading,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg font-medium"
      style={{
        padding: '6px 20px',
        fontSize: 12,
        color: danger ? '#fca5a5' : '#fff',
        background: danger ? 'rgba(220,38,38,0.2)' : 'rgba(255,255,255,0.1)',
        border: `0.5px solid ${danger ? 'rgba(220,38,38,0.4)' : 'rgba(255,255,255,0.15)'}`,
        opacity: disabled && !loading ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {loading ? `${label}…` : label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Memo                                                               */
/* ------------------------------------------------------------------ */

export const MobileParticipantTile = React.memo(
  MobileParticipantTileInner,
  (prev, next) =>
    prev.participant.identity === next.participant.identity &&
    prev.participant.name === next.participant.name &&
    prev.participant.isMicrophoneEnabled === next.participant.isMicrophoneEnabled &&
    prev.participant.isCameraEnabled === next.participant.isCameraEnabled &&
    prev.localIsHost === next.localIsHost &&
    prev.participantIsHost === next.participantIsHost &&
    prev.slug === next.slug &&
    prev.isVisible === next.isVisible &&
    prev.aspect === next.aspect,
);
