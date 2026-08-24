'use client';

// src/components/HiddenVideosBadge.tsx
//
// Restore surface for the FRS §5.x display-only hide. Because a hidden
// tile is dropped from the grid entirely (see HiddenVideoOverlay and
// MobileParticipantGrid), we need somewhere for the viewer to remember
// who they're hiding and bring them back — otherwise a locally-hidden
// participant is functionally gone.
//
// A single glassmorphic chip sits at the top of the room whenever the
// combined hidden set is non-empty. Clicking it opens a compact list of
// hidden participants with a Show button per row.
//
// Show semantics:
//   - Always clears the local hide (the viewer's own preference).
//   - If the participant is ALSO hidden globally AND the viewer has the
//     participant:hideVideo permission (host / cohost), it clears the
//     global hide too.
//   - Otherwise the row still restores locally; the global hide stays
//     for viewers who don't have the moderation right, which matches
//     the spec (only the moderator staff can reveal a broadcast hide).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParticipants } from '@livekit/components-react';
import { EyeOff } from 'lucide-react';
import { useHiddenVideos } from '@/components/HiddenVideosProvider';

export default function HiddenVideosBadge({
  roomRole,
}: {
  /** Wire-format role from the room page. 'host' covers owner+host after
   *  toLegacyRole; 'cohost' is moderator. Both hold participant:hideVideo. */
  roomRole?: string;
}) {
  const { hiddenSet, isHiddenGlobally, toggleLocal, toggleGlobal } = useHiddenVideos();
  const participants = useParticipants();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const canManageGlobal = roomRole === 'host' || roomRole === 'cohost';
  const count = hiddenSet.size;

  const identityNameMap = new Map<string, string>();
  for (const p of participants) {
    identityNameMap.set(p.identity, p.name || p.identity);
  }

  const entries = Array.from(hiddenSet).map((id) => ({
    id,
    name: identityNameMap.get(id) || id,
    isGlobal: isHiddenGlobally(id),
  }));

  const showAgain = useCallback(
    async (id: string, isGlobal: boolean) => {
      setError(null);
      setBusyId(id);
      try {
        // Always clear the local preference first — cheap, synchronous.
        toggleLocal(id, false);
        if (isGlobal && canManageGlobal) {
          await toggleGlobal(id, false);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [toggleLocal, toggleGlobal, canManageGlobal],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (count === 0 && open) setOpen(false);
  }, [count, open]);

  if (count === 0) return null;

  return (
    <div
      ref={rootRef}
      style={{
        position: 'fixed',
        top: 76,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 40,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${count} hidden video${count === 1 ? '' : 's'} — click to restore`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 999,
          background: 'rgba(11,16,32,0.85)',
          border: '1px solid rgba(255,255,255,0.15)',
          color: '#e5f8ff',
          fontSize: 12,
          fontWeight: 500,
          letterSpacing: 0.2,
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          cursor: 'pointer',
          boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
        }}
      >
        <EyeOff size={13} aria-hidden />
        {count} hidden
      </button>

      {open && (
        <div
          role="menu"
          style={{
            marginTop: 6,
            minWidth: 240,
            maxWidth: 320,
            padding: 6,
            borderRadius: 12,
            background: 'rgba(11,16,32,0.96)',
            border: '1px solid rgba(255,255,255,0.1)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
          }}
        >
          {entries.map((e) => {
            const canRestoreGlobally = e.isGlobal ? canManageGlobal : true;
            return (
              <div
                key={e.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 8,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      color: '#fff',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {e.name}
                  </div>
                  {e.isGlobal && (
                    <div
                      style={{
                        fontSize: 10,
                        color: 'rgba(226,232,240,0.55)',
                        letterSpacing: 0.3,
                        textTransform: 'uppercase',
                        marginTop: 1,
                      }}
                    >
                      {canManageGlobal
                        ? 'Hidden for everyone'
                        : 'Hidden by moderator'}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => showAgain(e.id, e.isGlobal)}
                  disabled={!canRestoreGlobally || busyId === e.id}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 12,
                    color: canRestoreGlobally ? '#0b1020' : 'rgba(226,232,240,0.4)',
                    background: canRestoreGlobally
                      ? 'rgba(34,211,238,0.9)'
                      : 'rgba(255,255,255,0.08)',
                    border: 'none',
                    cursor: canRestoreGlobally ? 'pointer' : 'not-allowed',
                    fontWeight: 600,
                  }}
                  title={
                    canRestoreGlobally
                      ? 'Show this video again'
                      : 'Only a host or cohost can restore a globally hidden video'
                  }
                >
                  {busyId === e.id ? '…' : 'Show'}
                </button>
              </div>
            );
          })}
          {error && (
            <div
              style={{
                fontSize: 11,
                color: '#fca5a5',
                padding: '4px 8px 2px',
              }}
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
