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
  slug,
}: {
  isHost: boolean;
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
        return createPortal(
          <HostTileMenu
            key={p.identity}
            participantIdentity={p.identity}
            participantName={displayName}
            isHost={true}
            slug={slug}
          />,
          tile,
          'host-tile-menu-' + p.identity,
        );
      })}
    </>
  );
}
