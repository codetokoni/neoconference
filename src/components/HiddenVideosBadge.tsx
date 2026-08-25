'use client';

// src/components/HiddenVideosBadge.tsx
//
// Restore surface for the FRS §5.x display-only hide. Because a hidden
// tile is dropped from the grid entirely (see HiddenVideoOverlay and
// MobileParticipantGrid), we need somewhere for the viewer to remember
// who they're hiding and bring them back — otherwise a locally-hidden
// participant is functionally gone.
//
// Renders as a normal toolbar entry (like Rename URL), with `data-in-more`
// so it collapses into the DesktopMoreMenu on desktop and shows in the
// MobileMoreMenu popover on mobile via the same runtime scan. Clicking
// opens a centered modal listing hidden participants with a Show button
// per row. No fixed floating chip.
//
// Show semantics:
//   - Always clears the local hide (the viewer's own preference).
//   - If the participant is ALSO hidden globally AND the viewer has the
//     participant:hideVideo permission (host / cohost), it clears the
//     global hide too.
//   - Otherwise the row still restores locally; the global hide stays
//     for viewers who don't have the moderation right, which matches
//     the spec (only the moderator staff can reveal a broadcast hide).

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParticipants } from '@livekit/components-react';
import { EyeOff } from 'lucide-react';
import { useHiddenVideos } from '@/components/HiddenVideosProvider';

const TOOLBAR_BTN_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-transparent px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/10 hover:border-white/25 active:scale-[0.98] transition';

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

  // Close automatically once the last hidden entry is restored.
  useEffect(() => {
    if (count === 0 && open) setOpen(false);
  }, [count, open]);

  const closeModal = useCallback(() => setOpen(false), []);

  // Escape closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeModal]);

  // No hidden entries → nothing to render (button disappears from the
  // toolbar; the DesktopMoreMenu / MobileMoreMenu scans skip it too since
  // it isn't in the DOM).
  if (count === 0) return null;

  return (
    <>
      {/* First-class toolbar entry (no data-in-more): appears in the row
          directly, so on desktop it inherits the toolbar's hover-to-
          reveal behaviour. On mobile the row itself is collapsed to
          zero size (see initials-overlay.css), and MobileMoreMenu's
          runtime scan of `.room-toolbar > button` picks this up so the
          entry still appears in the mobile More popover. */}
      <button
        type="button"
        data-toolbar-item="true"
        data-room-chrome="true"
        data-hidden-videos-trigger="true"
        onClick={() => setOpen(true)}
        aria-label={`${count} hidden video${count === 1 ? '' : 's'} — restore`}
        title="Restore a hidden video"
        className={TOOLBAR_BTN_CLASS}
      >
        <EyeOff size={16} aria-hidden />
        {count} hidden
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        // Portaled to document.body so the modal isn't a descendant of
        // `.room-toolbar` — otherwise the toolbar's hover-driven
        // opacity would cascade to the modal (CSS opacity flows to all
        // descendants regardless of stacking context) and the modal
        // would disappear the moment the cursor left the toolbar.
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Restore hidden videos"
          onClick={closeModal}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 80,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="rounded-2xl border border-white/15 bg-zinc-900/98 backdrop-blur p-5 w-full max-w-sm shadow-2xl"
          >
            <div className="text-base font-semibold text-white mb-1">
              Hidden videos
            </div>
            <div className="text-[12px] text-white/60 mb-3">
              These tiles aren&apos;t showing right now. Tap Show to bring one back.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '50vh', overflowY: 'auto' }}>
              {entries.map((e) => {
                const canRestoreGlobally = e.isGlobal ? canManageGlobal : true;
                return (
                  <div
                    key={e.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 4px',
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
                        padding: '5px 12px',
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
            </div>
            {error && (
              <div className="text-[12px] text-rose-300 mt-2">{error}</div>
            )}
            <div className="flex justify-end mt-4">
              <button
                type="button"
                onClick={closeModal}
                className="px-3 py-1.5 rounded-lg text-[13px] text-white/70 hover:text-white hover:bg-white/5"
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
