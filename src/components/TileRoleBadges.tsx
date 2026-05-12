'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParticipants } from '@livekit/components-react';
import { zIndex } from "@/lib/zIndex";

/**
 * TileRoleBadges
 *
 * Overlays a small role pill ('host' / 'co-host') at the top-left of every
 * participant's LiveKit video tile. Works for local + remote participants
 * and updates live on metadata changes.
 *
 * Identity model in this app:
 *  - participant.identity is '<clerkUserId>#<random>' (so two devices for the
 *    same user don't collide).
 *  - participant.name is the human-readable username (matches the text inside
 *    the tile's .lk-participant-name element).
 *  - The room owner is identified by ownerUserId (a clerk user_xxx string).
 *
 * We map tiles -> participants by the displayed name (== participant.name).
 */
export default function TileRoleBadges({ ownerUserId }: { ownerUserId: string | null }) {
  const participants = useParticipants();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1000000), 1200);
    return () => clearInterval(id);
  }, []);

  // Build name -> role map.
  const roleByName = new Map<string, 'host' | 'cohost'>();
  for (const p of participants) {
    if (!p) continue;
    const key = (p.name && p.name.length > 0 ? p.name : p.identity) || '';
    if (!key) continue;
    let role: 'host' | 'cohost' | null = null;
    // Host detection: identity is '<ownerUserId>#<suffix>' OR equals ownerUserId.
    if (ownerUserId && p.identity && (p.identity === ownerUserId || p.identity.startsWith(ownerUserId + '#'))) {
      role = 'host';
    } else if (p.metadata) {
      try {
        const j = JSON.parse(p.metadata);
        if (j && (j.role === 'host' || j.role === 'cohost')) role = j.role;
      } catch {
        // not JSON
      }
    }
    if (role) roleByName.set(key, role);
  }

  const items: Array<{ key: string; role: 'host' | 'cohost'; target: Element }> = [];
  if (typeof document !== 'undefined') {
    const tiles = document.querySelectorAll<HTMLElement>('.lk-participant-tile');
    tiles.forEach((tile, idx) => {
      const nameEl = tile.querySelector('.lk-participant-name, [data-lk-participant-name]');
      const displayed = nameEl ? (nameEl.textContent || '').trim() : '';
      if (!displayed) return;
      const role = roleByName.get(displayed);
      if (!role) return;
      items.push({ key: displayed + ':' + idx, role, target: tile });
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
              zIndex: zIndex.tileBadge,
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
