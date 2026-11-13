'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParticipants, useLocalParticipant } from '@livekit/components-react';
import { HostTileMenu, HostTileMenuPanel, closeTileMenu, useOpenTileMenu } from './HostTileMenu';
import { useIsMobile } from '@/hooks/useIsMobile';

/**
 * HostMenuOverlay
 *
 * Portals a <HostTileMenu /> into each remote participant's tile
 * (.lk-participant-tile) on a computer or tablet. Every viewer gets it, as
 * HostTileMenu intends ("Hide on my screen" is for anyone); the host and
 * moderator actions inside it stay gated on the viewer's role, and the
 * server checks the role again on each one.
 *
 * Tiles are matched by identity (`data-neo-identity`, set by
 * NeoVideoConference), preferring the camera tile over a screen share.
 * They used to be matched by display name, so two people with one name, or
 * one person on two devices, shared a single menu on the first such tile,
 * and a person's menu could land on their screen share instead.
 *
 * Only the ⋮ button lives in the tile. The open menu is drawn here, outside
 * every tile, so it stays open while LiveKit rebuilds or pages that tile,
 * and closes when the person leaves.
 */
export default function HostMenuOverlay({
  isHost,
  roomRole,
  slug,
}: {
  isHost: boolean;
  /** Wire-format role. Threaded through to HostTileMenu so roles and
   *  Remove are gated on owner+host. */
  roomRole?: string;
  slug: string;
}) {
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  // MobileParticipantTile has its own long-press host menu, so we skip the
  // desktop kebab-menu portal on mobile to avoid double UI.
  const isMobile = useIsMobile();
  const [tick, setTick] = useState(0);
  const openFor = useOpenTileMenu();
  const openPerson = openFor ? participants.find((p) => p.identity === openFor) : undefined;

  // Their menu goes when they leave the room, and only then.
  useEffect(() => {
    if (openFor && !openPerson) closeTileMenu();
  }, [openFor, openPerson]);

  // Re-scan tiles whenever the DOM mutates (tiles get added/removed/paginated).
  useEffect(() => {
    if (isMobile) return;
    let raf = 0;
    const obs = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setTick((t) => t + 1));
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => { obs.disconnect(); cancelAnimationFrame(raf); };
  }, [isMobile]);

  if (isMobile) return null;

  const localIdentity = localParticipant?.identity || '';
  const roleOf = (metadata: string | undefined): string | null => {
    // The target's wire-format role from LiveKit metadata, so role items
    // (e.g. Demote) show only when the target actually holds one.
    if (!metadata) return null;
    try {
      const j = JSON.parse(metadata) as { role?: unknown };
      return typeof j?.role === 'string' ? j.role : null;
    } catch {
      return null;
    }
  };
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
        const own = tiles.filter((el) => el.getAttribute('data-neo-identity') === p.identity);
        const tile = own.find((el) => el.getAttribute('data-neo-source') === 'camera') ?? own[0];
        if (!tile) return null;
        if (getComputedStyle(tile).position === 'static') {
          tile.style.position = 'relative';
        }
        return createPortal(
          <HostTileMenu key={p.identity} participantIdentity={p.identity} participantName={displayName} />,
          tile,
          'host-tile-menu-' + p.identity,
        );
      })}
      {openPerson && openPerson.identity !== localIdentity && (
        <HostTileMenuPanel
          key={openPerson.identity}
          participantIdentity={openPerson.identity}
          participantName={(openPerson.name || openPerson.identity || '').trim()}
          isHost={isHost}
          roomRole={roomRole}
          targetRole={roleOf(openPerson.metadata)}
          slug={slug}
        />
      )}
    </>
  );
}
