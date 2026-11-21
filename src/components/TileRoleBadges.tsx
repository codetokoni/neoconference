'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParticipants } from '@livekit/components-react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { tileIdentityOf } from '@/components/conference/roomLayout';
import { pinRoleOf, type PinRole } from '@/components/conference/rolePins';

type BadgeRole = PinRole;

const BADGE_STYLE: Record<BadgeRole, { bg: string; border: string; label: string }> = {
  owner: {
    bg: 'rgba(168,85,247,0.92)',     // violet — Owner is the top of the ladder
    border: 'rgba(196,140,255,0.95)',
    label: 'Owner',
  },
  host: {
    bg: 'rgba(80,140,220,0.92)',     // cyan/blue — the previous "host" hue
    border: 'rgba(140,180,240,0.95)',
    label: 'Host',
  },
  moderator: {
    bg: 'rgba(60,160,90,0.92)',      // green — the previous "co-host" hue
    border: 'rgba(120,210,150,0.95)',
    label: 'Moderator',
  },
};

/**
 * TileRoleBadges
 *
 * Overlays a role pill ("Owner" / "Host" / "Moderator") at the top-left of
 * every participant's LiveKit video tile. Live-updates on metadata changes.
 *
 * FRS §1 defines four roles (Owner, Host, Moderator, Participant); LiveKit
 * metadata carries only the wire-format "host" / "cohost" (owner and host
 * both collapse to "host" via toLegacyRole). We recover the Owner
 * distinction here by comparing participant.identity to the ownerUserId
 * prop the room page threads through.
 *
 * Identity model in this app:
 *  - participant.identity is '<clerkUserId>#<random>' so two devices for
 *    the same user don't collide.
 *  - participant.name is the human-readable username (matches the text
 *    inside the tile's .lk-participant-name element).
 *  - The room owner is identified by ownerUserId (a clerk user_xxx string).
 */
export default function TileRoleBadges({ ownerUserId }: { ownerUserId: string | null }) {
  const participants = useParticipants();
  // MobileParticipantTile renders its own role chip in the bottom pill,
  // so the desktop-style top-left badge would bleed through and look wrong.
  const isMobile = useIsMobile();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1000000), 1200);
    return () => clearInterval(id);
  }, []);

  if (isMobile) return null;

  // Role by identity (and by name, for a tile that says no identity).
  // The same rule as the pinned row (rolePins.ts), so a tile's badge and its
  // place in the row agree: the owner is the host whose token says owner,
  // or whose identity is ownerUserId's. By name alone, a Host badge went on
  // every tile of that name: another person called Grace looked like the
  // host.
  const roleById = new Map<string, BadgeRole>();
  const roleByName = new Map<string, BadgeRole>();
  for (const p of participants) {
    if (!p) continue;
    const key = (p.name && p.name.length > 0 ? p.name : p.identity) || '';
    if (!key) continue;
    const role: BadgeRole | null = p.identity ? pinRoleOf(p, ownerUserId) : null;
    if (role) {
      roleById.set(p.identity, role);
      roleByName.set(key, role);
    }
  }

  const items: Array<{ key: string; role: BadgeRole; target: Element }> = [];
  if (typeof document !== 'undefined') {
    const tiles = document.querySelectorAll<HTMLElement>('.lk-participant-tile');
    tiles.forEach((tile, idx) => {
      const identity = tileIdentityOf(tile);
      if (identity) {
        // A person's badge goes on their camera tile, not their screen.
        if (tile.getAttribute('data-neo-source') === 'screen_share') return;
        const role = roleById.get(identity);
        // By place as well: an enlarged host has two camera tiles (the
        // pinned row's and the big one), and one key for both dropped a badge.
        if (role) items.push({ key: identity + ':' + idx, role, target: tile });
        return;
      }
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
      {items.map((it) => {
        const style = BADGE_STYLE[it.role];
        return createPortal(
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
              background: style.bg,
              border: '1px solid ' + style.border,
              color: 'white',
              boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
              zIndex: 5,
              pointerEvents: 'none',
              userSelect: 'none',
              letterSpacing: 0.2,
            }}
          >
            {style.label}
          </span>,
          it.target as Element,
          'tile-role-badge-' + it.key,
        );
      })}
    </>
  );
}
