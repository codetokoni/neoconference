'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRoomContext } from '@livekit/components-react';
import { HostTileMenu } from './HostTileMenu';

/**
 * HostMenuOverlay
 *
 * Mounted once inside <LiveKitRoom>. When the local user is host, it scans
 * the DOM for .lk-participant-tile elements and matches each one to a
 * remote LiveKit Participant via its data-lk-participant-name. It then
 * portals a <HostTileMenu /> into every remote tile so the host can mute
 * mic/cam or remove that participant.
 */
export default function HostMenuOverlay({
  isHost,
  slug,
}: {
  isHost: boolean;
  slug: string;
}) {
  const room = useRoomContext();
  const [tick, setTick] = useState(0);
  const [tiles, setTiles] = useState<HTMLElement[]>([]);

  // Re-render whenever participants join/leave so the tile list is fresh.
  useEffect(() => {
    if (!room) return;
    const bump = () => setTick((t) => t + 1);
    const events = ['participantConnected','participantDisconnected','trackPublished','trackUnpublished','trackMuted','trackUnmuted'];
    for (const e of events) (room as any).on?.(e, bump);
    return () => { for (const e of events) (room as any).off?.(e, bump); };
  }, [room]);

  useEffect(() => {
    if (!isHost) return;
    const collect = () => {
      const list = Array.from(
        document.querySelectorAll<HTMLElement>('.lk-participant-tile'),
      );
      setTiles(list);
    };
    collect();
    const obs = new MutationObserver(() => {
      requestAnimationFrame(collect);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [isHost, tick]);

  if (!isHost || !room) return null;

  // Build a name -> identity map from current remote participants.
  const remotes = Array.from((room as any).remoteParticipants?.values?.() ?? []);
  const localIdentity = (room as any).localParticipant?.identity ?? '';

  return (
    <>
      {tiles.map((tile, i) => {
        const nameEl = tile.querySelector('[data-lk-participant-name]') as HTMLElement | null;
        const tileName = nameEl?.getAttribute('data-lk-participant-name')?.trim() || '';
        const isLocalTile = tile.getAttribute('data-lk-local-participant') === 'true' || tile.querySelector('[data-lk-local-participant="true"]') !== null;

        // Skip the local participant's own tile -- host shouldn't moderate themselves here.
        if (isLocalTile) return null;

        // Match this tile to a remote participant by name; fall back to identity match.
        const match = (remotes as any[]).find((p) => (p.name || p.identity) === tileName) || (remotes as any[]).find((p) => p.identity === tileName);
        const identity = match?.identity || tileName;
        if (!identity || identity === localIdentity) return null;

        // Ensure the tile can host an absolutely-positioned overlay.
        if (getComputedStyle(tile).position === 'static') {
          tile.style.position = 'relative';
        }

        return createPortal(
          <HostTileMenu identity={identity} name={tileName || identity} slug={slug} />,
          tile,
          'host-tile-menu-' + i + '-' + identity,
        );
      })}
    </>
  );
}
