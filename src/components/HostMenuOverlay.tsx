'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParticipants, useLocalParticipant } from '@livekit/components-react';
import { HostTileMenu } from './HostTileMenu';
import { useIsMobile } from '@/hooks/useIsMobile';

/**
 * HostMenuOverlay
 *
 * For host/cohost only. Iterates remote LiveKit participants and portals
 * a <HostTileMenu /> into each one's tile DOM (.lk-participant-tile).
 * Tiles are matched to participants via data-lk-participant-name.
 */
export default function HostMenuOverlay({
  isHost,
  isOwner = false,
  roomRole,
  slug,
}: {
  isHost: boolean;
  /** Threaded through to HostTileMenu so the FRS §1.1 "Make Host"
   *  action is gated on owner only (a plain host cannot appoint
   *  another host). Also unlocks the same role/moderation surface for
   *  a real owner whose LiveKit metadata hasn't reported "host" yet. */
  isOwner?: boolean;
  /** Wire-format role. Threaded through to HostTileMenu so the §5.2
   *  "Mute everyone else" option is gated on owner+host. */
  roomRole?: string;
  slug: string;
}) {
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  // MobileParticipantTile has its own long-press host menu, so we skip the
  // desktop kebab-menu portal on mobile to avoid double UI.
  const isMobile = useIsMobile();
  const [tick, setTick] = useState(0);

  // Re-scan tiles whenever the DOM mutates (tiles get added/removed/paginated).
  useEffect(() => {
    if (!isHost || isMobile) return;
    let raf = 0;
    const obs = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setTick((t) => t + 1));
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => { obs.disconnect(); cancelAnimationFrame(raf); };
  }, [isHost, isMobile]);

  if (!isHost || isMobile) return null;

  const localIdentity = localParticipant?.identity || '';
  // Snapshot tiles (read at render time; tick triggers re-render).
  void tick;
  const tiles = typeof document !== 'undefined'
    ? Array.from(document.querySelectorAll<HTMLElement>('.lk-participant-tile'))
    : [];

  return (
    <>
      {participants.map((p) => {
        if (!p || p.identity === localIdentity) return null;
        const displayName = (p.name || p.identity || '').trim();
        // Find the FIRST tile in DOM whose name matches AND isn't already mounted.
        // Multiple tiles may share the same name in test setups; that's fine -- we mount per identity.
        const tile = tiles.find((el) => {
          const nameEl = el.querySelector('[data-lk-participant-name]') as HTMLElement | null;
          const tileName = nameEl?.getAttribute('data-lk-participant-name')?.trim() || '';
          if (tileName !== displayName) return false;
          const isLocalTile = el.querySelector('[data-lk-local-participant="true"]') !== null;
          return !isLocalTile;
        });
        if (!tile) return null;
        if (getComputedStyle(tile).position === 'static') {
          tile.style.position = 'relative';
        }
        // Read target's wire-format role from LiveKit metadata so we
        // can gate role-management items (e.g. Demote is only shown
        // when the target actually holds an elevated role).
        let targetRole: string | null = null;
        if (p.metadata) {
          try {
            const j = JSON.parse(p.metadata) as { role?: unknown };
            if (typeof j?.role === 'string') targetRole = j.role;
          } catch {
            // ignore
          }
        }
        return createPortal(
          <HostTileMenu
            key={p.identity}
            participantIdentity={p.identity}
            participantName={displayName}
            isHost={true}
            isOwner={isOwner}
            roomRole={roomRole}
            targetRole={targetRole}
            slug={slug}
          />,
          tile,
          'host-tile-menu-' + p.identity,
        );
      })}
    </>
  );
}
