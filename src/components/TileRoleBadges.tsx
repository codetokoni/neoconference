'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useParticipants } from '@livekit/components-react';

/**
 * TileRoleBadges
 *
 * Overlays a small role pill ('host' / 'co-host') at the top-left of every
 * participant's LiveKit video tile in the room. Works for the local user and
 * every remote participant. Updates live when the host promotes/demotes a
 * co-host (driven by the ParticipantMetadataChanged event already wired in
 * page.tsx).
 *
 * Mount this once inside <LiveKitRoom>. It returns React portals into each
 * .lk-participant-tile, so it does not affect tile layout/sizing.
 */
export default function TileRoleBadges({ ownerUserId }: { ownerUserId: string | null }) {
  // Subscribe to all participants — useParticipants re-runs on join/leave and
  // on every metadata change, so portal targets and badge content stay fresh.
  const participants = useParticipants();
  // Force a re-render on a small interval if the tile element isn't mounted
  // yet at first render (some LiveKit chrome appears after initial connect).
  const tickRef = useRef(0);

  useEffect(() => {
    const id = setInterval(() => {
      tickRef.current += 1;
    }, 1500);
    return () => clearInterval(id);
  }, []);

  // Locate one tile element per participant.identity.
  const items: Array<{ identity: string; role: 'host' | 'cohost'; target: Element }> = [];
  for (const p of participants) {
    if (!p || !p.identity) continue;
    let role: 'host' | 'cohost' | null = null;
    if (ownerUserId && p.identity === ownerUserId) {
      role = 'host';
    } else if (p.metadata) {
      try {
        const j = JSON.parse(p.metadata);
        if (j && (j.role === 'host' || j.role === 'cohost')) role = j.role;
      } catch {
        // ignore — metadata isn't JSON
      }
    }
    if (!role) continue;

    // LiveKit renders tiles with the identity attribute. Find the tile
    // element so we can portal a badge into it.
    const sel = '[data-lk-participant-identity="' + (window.CSS && window.CSS.escape ? window.CSS.escape(p.identity) : p.identity) + '"]';
    const target = document.querySelector(sel);
    if (!target) continue;
    items.push({ identity: p.identity, role, target });
  }

  return (
    <>
      {items.map((it) =>
        createPortal(
          <span
            data-tile-role-badge={it.role}
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              padding: '2px 8px',
              fontSize: 11,
              fontWeight: 700,
              lineHeight: '16px',
              borderRadius: 999,
              background:
                it.role === 'host'
                  ? 'rgba(80,140,220,0.85)'
                  : 'rgba(60,160,90,0.88)',
              border:
                '1px solid ' +
                (it.role === 'host' ? 'rgba(140,180,240,0.9)' : 'rgba(120,210,150,0.95)'),
              color: 'white',
              boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
              zIndex: 5,
              pointerEvents: 'none',
              userSelect: 'none',
              letterSpacing: 0.2,
            }}
          >
            {it.role === 'host' ? 'host' : 'co-host'}
          </span>,
          it.target,
          'tile-role-badge-' + it.identity,
        ),
      )}
    </>
  );
}
