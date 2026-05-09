'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { HostTileMenu } from './HostTileMenu';

/**
 * HostMenuOverlay
 *
 * Mounted once inside <LiveKitRoom>. When the local user is host, scans the
 * DOM for .lk-participant-tile elements and injects a <HostTileMenu /> into
 * each one (excluding the local participant's own tile). Uses MutationObserver
 * so newly-added tiles (e.g. when participants join, or when paginating) get
 * their menu attached automatically.
 *
 * This works for BOTH the desktop <VideoConference /> layout and the custom
 * <MobileVideoConference /> grid since both use LiveKit's <ParticipantTile />
 * which carries `data-lk-participant-identity`.
 */
export default function HostMenuOverlay({
  isHost,
  slug,
}: {
  isHost: boolean;
  slug: string;
}) {
  const [tiles, setTiles] = useState<HTMLElement[]>([]);

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
      // Coalesce updates with rAF to avoid thrashing.
      requestAnimationFrame(collect);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    return () => obs.disconnect();
  }, [isHost]);

  if (!isHost) return null;

  return (
    <>
      {tiles.map((tile, i) => {
        // LiveKit puts the participant identity on a child element with a
        // `data-lk-participant-identity` attribute, OR on the tile itself.
        const idEl = tile.querySelector('[data-lk-participant-identity]') as
          | HTMLElement
          | null;
        const identity =
          idEl?.getAttribute('data-lk-participant-identity') ||
          tile.getAttribute('data-lk-participant-identity') ||
          '';
        if (!identity) return null;

        // Try to read a friendly display name from a name span.
        const nameEl = tile.querySelector('.lk-participant-name') as
          | HTMLElement
          | null;
        const name = nameEl?.textContent?.trim() || identity;

        // Ensure tile can host an absolutely-positioned overlay.
        if (getComputedStyle(tile).position === 'static') {
          tile.style.position = 'relative';
        }

        return createPortal(
          <HostTileMenu
            key={identity + ':' + i}
            participantIdentity={identity}
            participantName={name}
            isHost={isHost}
            slug={slug}
          />,
          tile,
        );
      })}
    </>
  );
}
