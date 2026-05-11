'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParticipants } from '@livekit/components-react';

/**
 * TileRoleBadges
 *
 * Overlays a small role pill ('host' / 'co-host') at the top-left of every
 * participant's LiveKit video tile. Works for local + remote participants
 * and updates live on metadata changes.
 *
 * Identity resolution: LiveKit React does not stamp the identity on the tile
 * root, but it renders a child .lk-participant-name whose text equals the
 * participant identity. We use that to map tile -> identity.
 */
export default function TileRoleBadges({ ownerUserId }: { ownerUserId: string | null }) {
  const participants = useParticipants();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1000000), 1200);
    return () => clearInterval(id);
  }, []);

  const roleByIdentity = new Map<string, 'host' | 'cohost'>();
  for (const p of participants) {
    if (!p || !p.identity) continue;
    if (ownerUserId && p.identity === ownerUserId) {
      roleByIdentity.set(p.identity, 'host');
      continue;
    }
    if (p.metadata) {
      try {
        const j = JSON.parse(p.metadata);
        if (j && (j.role === 'host' || j.role === 'cohost')) {
          roleByIdentity.set(p.identity, j.role);
        }
      } catch {
        // not JSON — ignore
      }
    }
  }

  const items: Array<{ key: string; role: 'host' | 'cohost'; target: Element }> = [];
  if (typeof document !== 'undefined') {
    const tiles = document.querySelectorAll<HTMLElement>('.lk-participant-tile');
    tiles.forEach((tile, idx) => {
      const nameEl = tile.querySelector('.lk-participant-name, [data-lk-participant-name]');
      const identity = nameEl ? (nameEl.textContent || '').trim() : '';
      if (!identity) return;
      const role = roleByIdentity.get(identity);
      if (!role) return;
      items.push({ key: identity + ':' + idx, role, target: tile });
    });
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
                  ? 'rgba(80,140,220,0.92)'
                  : 'rgba(60,160,90,0.92)',
              border:
                '1px solid ' +
                (it.role === 'host' ? 'rgba(140,180,240,0.95)' : 'rgba(120,210,150,0.95)'),
              color: 'white',
              boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
              zIndex: 5,
              pointerEvents: 'none',
              userSelect: 'none',
              letterSpacing: 0.2,
              textTransform: 'lowercase',
            }}
          >
            {it.role === 'host' ? 'host' : 'co-host'}
          </span>,
          it.target as Element,
          'tile-role-badge-' + it.key,
        ),
      )}
    </>
  );
}
