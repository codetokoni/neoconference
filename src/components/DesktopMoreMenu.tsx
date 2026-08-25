'use client';

// src/components/DesktopMoreMenu.tsx
//
// Desktop counterpart to MobileMoreMenu. Consolidates the less-frequent
// toolbar buttons into a single "More" dropdown so the top toolbar fits
// on one row and stops covering the video with a wrapped second row.
//
// Which buttons live in More is opt-in: any button in the top toolbar
// with `data-in-more="true"` is hidden from the visible row (via CSS)
// and surfaced here instead. That keeps the source of truth for what
// each action does colocated with the toolbar declaration in
// src/app/room/[name]/page.tsx — this component doesn't hardcode any
// action or handler.
//
// On mobile the whole toolbar is collapsed to zero size (see
// initials-overlay.css); the mobile MobileMoreMenu component picks the
// same buttons up via its own scan of `.room-toolbar > button` so users
// still get every action there.
//
// The dropdown button itself is marked `data-mobile-skip="true"` so
// MobileMoreMenu's scan doesn't list a nested "More" entry inside its
// own popover.

import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

const TOOLBAR_BTN_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-transparent px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/10 hover:border-white/25 active:scale-[0.98] transition';

type MoreEntry = { label: string; target: HTMLButtonElement };

export default function DesktopMoreMenu() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MoreEntry[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  /** Snapshot the current toolbar's in-more buttons at open time so the
   *  labels reflect any per-render state (e.g. a "Hide me" that toggles
   *  to "Show me"). */
  const scan = (): MoreEntry[] => {
    const list: MoreEntry[] = [];
    const btns = document.querySelectorAll<HTMLButtonElement>(
      '.room-toolbar > button[data-in-more="true"]',
    );
    btns.forEach((b) => {
      const label = (b.textContent || '').trim();
      if (!label) return;
      list.push({ label, target: b });
    });
    const seen = new Set<string>();
    return list.filter((it) => {
      const key = it.label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const handleToggle = () => {
    if (!open) setItems(scan());
    setOpen((v) => !v);
  };

  const pick = (entry: MoreEntry) => {
    try {
      entry.target.click();
    } catch {
      // ignore — proxied button may have detached
    }
    setOpen(false);
  };

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

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        data-toolbar-item="true"
        data-room-chrome="true"
        data-mobile-skip="true"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        title="More actions"
        onClick={handleToggle}
        className={TOOLBAR_BTN_CLASS}
      >
        <MoreHorizontal size={16} aria-hidden />
        More
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 200,
            padding: 6,
            borderRadius: 12,
            background: 'rgba(11,16,32,0.96)',
            border: '1px solid rgba(255,255,255,0.1)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            zIndex: 50,
          }}
        >
          {items.length === 0 && (
            <div
              style={{
                fontSize: 12,
                color: 'rgba(226,232,240,0.55)',
                padding: '8px 10px',
              }}
            >
              No extra actions available.
            </div>
          )}
          {items.map((it, i) => (
            <button
              key={i + ':' + it.label}
              type="button"
              role="menuitem"
              onClick={() => pick(it)}
              style={{
                width: '100%',
                display: 'block',
                textAlign: 'left',
                padding: '8px 12px',
                borderRadius: 8,
                background: 'transparent',
                color: '#fff',
                border: 'none',
                fontSize: 13,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  'rgba(255,255,255,0.06)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
