'use client';

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { motion } from 'framer-motion';
import { MicOff } from 'lucide-react';
import { ParticipantEvent, Track, type Participant } from 'livekit-client';
import { useIsSpeaking, VideoTrack } from '@livekit/components-react';
import {
  getAvatarColor,
  getAvatarColorRGB,
  getInitials,
} from '@/lib/avatarColor';
import { useHiddenVideos } from '@/components/HiddenVideosProvider';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MobileParticipantTileProps {
  participant: Participant;
  localIsHost: boolean;
  /** Whether the local viewer is the actual event owner — controls the
   *  Make Host action gate in the long-press menu (FRS §1.1). */
  localIsOwner?: boolean;
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
@keyframes mobile-tile-spin {
  to { transform: rotate(360deg); }
}
.mobile-tile-spin {
  animation: mobile-tile-spin 1.2s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .mobile-tile-spin { animation: none; }
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
  localIsOwner = false,
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

  /* ---------- camera track detection ---------- *
   *
   * Two things conspire to leave remote tiles stuck on the avatar on
   * mobile when subscription lags behind the first render:
   *
   *   1. `camPub.isSubscribed` is read at render time. Nothing here
   *      subscribes to LiveKit's TrackSubscribed / TrackUnsubscribed
   *      events, so a subscription that lands after the first commit
   *      never triggers a re-derive.
   *   2. The React.memo comparator below gates on the sender-side
   *      `participant.isCameraEnabled`, which is already true when we
   *      joined a room whose peers have their cameras on — so a later
   *      subscribe event does not change any memoed prop, and the
   *      parent's re-render from `useParticipants()` is skipped.
   *
   * `subTick` is a lightweight internal counter that increments on the
   * participant's track-lifecycle events. Because it lives inside the
   * memoed component it forces its own re-render regardless of memo
   * gating, so `camPub` and `hasCam` get re-evaluated the moment the
   * subscription completes.
   */
  const [subTick, setSubTick] = useState(0);
  useEffect(() => {
    const bump = () => setSubTick((t) => t + 1);
    participant.on(ParticipantEvent.TrackSubscribed, bump);
    participant.on(ParticipantEvent.TrackUnsubscribed, bump);
    participant.on(ParticipantEvent.TrackMuted, bump);
    participant.on(ParticipantEvent.TrackUnmuted, bump);
    participant.on(ParticipantEvent.TrackPublished, bump);
    participant.on(ParticipantEvent.TrackUnpublished, bump);
    participant.on(ParticipantEvent.LocalTrackPublished, bump);
    participant.on(ParticipantEvent.LocalTrackUnpublished, bump);
    participant.on(ParticipantEvent.TrackSubscriptionFailed, bump);
    return () => {
      participant.off(ParticipantEvent.TrackSubscribed, bump);
      participant.off(ParticipantEvent.TrackUnsubscribed, bump);
      participant.off(ParticipantEvent.TrackMuted, bump);
      participant.off(ParticipantEvent.TrackUnmuted, bump);
      participant.off(ParticipantEvent.TrackPublished, bump);
      participant.off(ParticipantEvent.TrackUnpublished, bump);
      participant.off(ParticipantEvent.LocalTrackPublished, bump);
      participant.off(ParticipantEvent.LocalTrackUnpublished, bump);
      participant.off(ParticipantEvent.TrackSubscriptionFailed, bump);
    };
  }, [participant]);
  // Reference subTick so lint doesn't flag it — its purpose is the
  // re-render, not the value.
  void subTick;

  // Target participant's wire-format role, read from LiveKit metadata that
  // the room writes on assignment (see /api/events/[id]/roles broadcast).
  // Used to conditionally show role-management items — e.g. "Demote to
  // Participant" only makes sense when the target actually holds an
  // elevated role right now.
  const targetRole = (() => {
    if (!participant?.metadata) return null;
    try {
      const j = JSON.parse(participant.metadata) as { role?: unknown };
      return typeof j?.role === 'string' ? j.role : null;
    } catch {
      return null;
    }
  })();
  const targetIsElevated = targetRole === 'host' || targetRole === 'cohost';

  const camPub = participant.getTrackPublication(Track.Source.Camera);
  // FRS §5.x display-only hide. When the tile is either locally or
  // globally hidden we short-circuit hasCam so the render path swaps to
  // the avatar (the subscription stays alive so reveal is instant).
  const hidden = useHiddenVideos();
  const isHidden = hidden.isHidden(participant.identity);
  const isHiddenLocally = hidden.isHiddenLocally(participant.identity);
  const isHiddenGlobally = hidden.isHiddenGlobally(participant.identity);
  const hasCam = !!(camPub?.isSubscribed && !camPub.isMuted) && !isHidden;
  const trackSid = camPub?.trackSid;

  /* ---------- first-frame tracking for cross-fade ---------- */
  // Without this, the tile snaps from avatar to video the moment LiveKit
  // subscribes the track — but frames take 1-3s to arrive. We crossfade
  // when the video element actually has decoded data.
  const [hasFirstFrame, setHasFirstFrame] = useState(false);
  const videoElRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setHasFirstFrame(false);
    if (!hasCam) return;
    const video = videoElRef.current;
    if (!video) return;
    // If the video already has decoded data (e.g. fast reconnect), skip the fade.
    if (video.readyState >= 2 /* HAVE_CURRENT_DATA */) {
      setHasFirstFrame(true);
      return;
    }
    const onLoaded = () => setHasFirstFrame(true);
    video.addEventListener('loadeddata', onLoaded);
    return () => video.removeEventListener('loadeddata', onLoaded);
  }, [hasCam, trackSid]);

  /* ---------- host menu (long press) ---------- */
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);

  // Spotlight is host-level. Fire the same dblclick that
  // SpotlightOverlay listens for at the document level (see
  // src/components/SpotlightOverlay.tsx) so this menu item is exactly
  // equivalent to the double-tap gesture we already ship — no duplicate
  // data-channel wiring, no drift.
  const spotlightTarget = useCallback(() => {
    if (!rootRef.current) return;
    rootRef.current.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    onSpotlight?.(participant.identity);
    setMenuOpen(false);
  }, [onSpotlight, participant.identity]);

  const toggleHideLocal = useCallback(() => {
    hidden.toggleLocal(participant.identity, !isHiddenLocally);
    setMenuOpen(false);
  }, [hidden, participant.identity, isHiddenLocally]);

  const toggleHideGlobal = useCallback(async () => {
    setMenuError(null);
    setPending('hideGlobal');
    try {
      await hidden.toggleGlobal(participant.identity, !isHiddenGlobally);
      setMenuOpen(false);
    } catch (e) {
      setMenuError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }, [hidden, participant.identity, isHiddenGlobally]);
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
    async (
      action:
        | 'muteAudio'
        | 'muteVideo'
        | 'kick'
        | 'requestUnmuteAudio'
        | 'requestCameraOn',
    ) => {
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

  const muteEveryoneElse = useCallback(async () => {
    setMenuError(null);
    setPending('muteAll');
    try {
      const r = await fetch('/api/livekit/muteAll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomName: slug, exceptIdentity: participant.identity }),
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
  }, [slug, participant.identity]);

  const assignRole = useCallback(
    async (role: 'host' | 'moderator' | 'participant') => {
      setMenuError(null);
      setPending('role:' + role);
      try {
        // Identity often carries a "#nn" LiveKit disambiguation suffix
        // that the roles route needs stripped, matching how the desktop
        // ParticipantsPanel derives targetUserId.
        const targetUserId = participant.identity.split('#')[0];
        const r = await fetch(`/api/events/${encodeURIComponent(slug)}/roles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: targetUserId, role }),
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
      // double-tap — spotlight is a host-level action, so owner counts too.
      if ((localIsHost || localIsOwner) && rootRef.current) {
        rootRef.current.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        onSpotlight?.(participant.identity);
      }
      lastTap.current = 0;
    } else {
      lastTap.current = now;
    }
  }, [localIsHost, localIsOwner, onSpotlight, participant.identity]);

  /* ---------- pointer handlers (long press + tap) ----------
   *
   * Long-press opens the tile menu. Previously that was gated on
   * localIsHost because the menu only had moderation actions; now
   * everyone can hide a tile on their own screen, so the menu is
   * available to any viewer looking at any remote tile. Self-tiles
   * still don't get a menu (nothing to do). */
  const canOpenMenu = !participant.isLocal;
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      pressOrigin.current = { x: e.clientX, y: e.clientY };
      if (canOpenMenu) {
        pressTimer.current = setTimeout(() => {
          setMenuOpen(true);
          pressTimer.current = null;
        }, 500);
      }
    },
    [canOpenMenu],
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

      {/* Video — mounted while the track exists; fades in once the first
          frame is decoded. Keyed by trackSid so a camera swap (front↔back,
          off→on) tears down the old element and re-runs the first-frame
          effect for the new stream. */}
      {hasCam && camPub?.videoTrack && (
        <VideoTrack
          key={trackSid}
          ref={videoElRef}
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
            opacity: hasFirstFrame ? 1 : 0,
            transition: 'opacity 300ms ease-out',
          }}
        />
      )}

      {/* Avatar — always mounted; fades out once first frame lands so the
          DOM stays stable across transitions and there's no layout flash. */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{
          opacity: hasCam && hasFirstFrame ? 0 : 1,
          transition: 'opacity 300ms ease-out',
        }}
      >
        <div className="relative">
          {/* Connecting indicator: cyan arc that spins around the avatar
              while the camera is on but no frames have arrived yet. */}
          {hasCam && !hasFirstFrame && (
            <div
              className="mobile-tile-spin absolute -inset-2 rounded-full border-2 border-transparent pointer-events-none"
              style={{ borderTopColor: 'rgb(34, 211, 238)' }}
              aria-hidden
            />
          )}
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
      </div>

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

      {/* Long-press action menu. Full moderation surface so the host
          never needs to leave the grid to promote, demote, or discipline
          a participant. Grouped into sections: My view · For everyone ·
          Role · Danger. Scrolls inside the tile when the tile is too
          short to fit the full list. */}
      {menuOpen && canOpenMenu && (
        <div
          className="absolute inset-0 z-20"
          style={{
            background: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            transition: 'opacity 150ms ease-out',
            overflowY: 'auto',
            paddingBlock: 8,
          }}
          // Tap anywhere on the backdrop closes the menu — matches the
          // native bottom-sheet gesture. Individual buttons stopPropagation
          // via their own click handler (button clicks don't bubble to us
          // because of the inner content wrapper's stopPropagation below).
          onClick={() => setMenuOpen(false)}
        >
          <div
            className="flex flex-col items-center gap-1 px-2"
            onClick={(e) => e.stopPropagation()}
          >
            <MenuSection label="My view" />
            <MenuBtn
              label={isHiddenLocally ? 'Show on my screen' : 'Hide on my screen'}
              disabled={pending !== null}
              onClick={toggleHideLocal}
            />

            {(localIsHost || localIsOwner) && (
              <>
                <MenuSection label="For everyone" />
                <MenuBtn
                  label="Spotlight"
                  disabled={pending !== null}
                  onClick={spotlightTarget}
                />
                <MenuBtn
                  label={isHiddenGlobally ? 'Show video for everyone' : 'Hide video for everyone'}
                  disabled={pending !== null}
                  loading={pending === 'hideGlobal'}
                  onClick={toggleHideGlobal}
                />
                <MenuBtn
                  label="Mute mic"
                  disabled={pending !== null}
                  loading={pending === 'muteAudio'}
                  onClick={() => handleModerate('muteAudio')}
                />
                <MenuBtn
                  label="Turn off camera"
                  disabled={pending !== null}
                  loading={pending === 'muteVideo'}
                  onClick={() => handleModerate('muteVideo')}
                />
                <MenuBtn
                  label="Ask to unmute"
                  disabled={pending !== null}
                  loading={pending === 'requestUnmuteAudio'}
                  onClick={() => handleModerate('requestUnmuteAudio')}
                />
                <MenuBtn
                  label="Ask to turn on camera"
                  disabled={pending !== null}
                  loading={pending === 'requestCameraOn'}
                  onClick={() => handleModerate('requestCameraOn')}
                />
                <MenuBtn
                  label="Mute everyone else"
                  disabled={pending !== null}
                  loading={pending === 'muteAll'}
                  onClick={muteEveryoneElse}
                />

                <MenuSection label="Role" />
                {localIsOwner && (
                  <MenuBtn
                    label="Make Host"
                    disabled={pending !== null}
                    loading={pending === 'role:host'}
                    onClick={() => assignRole('host')}
                  />
                )}
                <MenuBtn
                  label="Make Moderator"
                  disabled={pending !== null}
                  loading={pending === 'role:moderator'}
                  onClick={() => assignRole('moderator')}
                />
                {/* Only surfaces when the target actually holds an elevated
                    role right now — otherwise there's nothing to demote. */}
                {targetIsElevated && (
                  <MenuBtn
                    label="Demote to Participant"
                    disabled={pending !== null}
                    loading={pending === 'role:participant'}
                    onClick={() => assignRole('participant')}
                  />
                )}

                <MenuSection label="Danger" />
                <MenuBtn
                  label="Remove from room"
                  danger
                  disabled={pending !== null}
                  loading={pending === 'kick'}
                  onClick={() => handleModerate('kick')}
                />
              </>
            )}

            {menuError && (
              <span className="text-red-400 mt-1" style={{ fontSize: 10 }}>
                {menuError}
              </span>
            )}
            <button
              type="button"
              className="text-white/50 mt-1.5"
              style={{ fontSize: 11, background: 'none', border: 'none', padding: '4px 8px' }}
              onClick={() => setMenuOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Menu section header (internal)                                      */
/* ------------------------------------------------------------------ */

function MenuSection({ label }: { label: string }) {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: 220,
        marginTop: 6,
        paddingLeft: 4,
        fontSize: 9,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.42)',
      }}
    >
      {label}
    </div>
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
    prev.localIsOwner === next.localIsOwner &&
    prev.participantIsHost === next.participantIsHost &&
    prev.slug === next.slug &&
    prev.isVisible === next.isVisible &&
    prev.aspect === next.aspect,
);
