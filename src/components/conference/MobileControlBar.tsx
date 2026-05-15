'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Video, VideoOff, MoreHorizontal } from 'lucide-react';
import { useLocalParticipant } from '@livekit/components-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MobileControlBarProps {
  onLeave: () => void;
}

type ToolbarItem = { label: string; el: HTMLButtonElement };

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function MobileControlBar({ onLeave }: MobileControlBarProps) {
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const [moreOpen, setMoreOpen] = useState(false);
  const [items, setItems] = useState<ToolbarItem[]>([]);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  /* ---- mic / cam ---- */
  const toggleMic = useCallback(() => {
    localParticipant?.setMicrophoneEnabled(!isMicrophoneEnabled).catch(() => {});
  }, [localParticipant, isMicrophoneEnabled]);

  const toggleCam = useCallback(() => {
    localParticipant?.setCameraEnabled(!isCameraEnabled).catch(() => {});
  }, [localParticipant, isCameraEnabled]);

  /* ---- More menu: runtime toolbar scan (preserved exactly) ---- */
  const refreshItems = useCallback(() => {
    const list: ToolbarItem[] = [];
    const btns = document.querySelectorAll<HTMLButtonElement>('.room-toolbar > button');
    btns.forEach((b) => {
      const label = (b.textContent || '').trim();
      if (!label) return;
      list.push({ label, el: b });
    });
    const seen = new Set<string>();
    setItems(
      list.filter((it) => {
        const k = it.label.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
    );
  }, []);

  const fire = useCallback((it: ToolbarItem) => {
    try {
      const lbl = (it.label || '').toLowerCase();
      // Recording button bridge: RecordingControls exposes window.__ncRecordToggle
      // so we trigger it directly instead of proxying a programmatic .click().
      const isRec = lbl.includes('record') || lbl.includes('waiting for host');
      const toggle = (window as unknown as Record<string, unknown>).__ncRecordToggle;
      if (isRec && typeof toggle === 'function') {
        (toggle as () => void)();
      } else {
        it.el.click();
      }
    } catch { /* best effort */ }
    setMoreOpen(false);
  }, []);

  const openMore = useCallback(() => {
    refreshItems();
    setMoreOpen(true);
  }, [refreshItems]);

  const closeMore = useCallback(() => setMoreOpen(false), []);

  /* ---- focus management ---- */
  useEffect(() => {
    if (moreOpen) {
      const t = setTimeout(() => firstItemRef.current?.focus(), 50);
      return () => clearTimeout(t);
    } else {
      moreBtnRef.current?.focus();
    }
  }, [moreOpen]);

  /* ---- click outside ---- */
  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        closeMore();
      }
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [moreOpen, closeMore]);

  /* ---- Escape ---- */
  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMore();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [moreOpen, closeMore]);

  /* ---- styles ---- */
  const pill = 'flex items-center gap-1.5 rounded-full px-3 py-2 text-xs text-white';
  const pillEnabled =
    'bg-[rgba(255,255,255,0.06)] border-[0.5px] border-[rgba(255,255,255,0.1)]';
  const pillDisabled =
    'bg-[rgba(220,38,38,0.15)] border-[0.5px] border-[rgba(220,38,38,0.4)]';

  return (
    <div
      role="toolbar"
      aria-label="Call controls"
      className="flex items-center justify-around px-4 py-2.5 bg-black/40 backdrop-blur-md border-t border-white/10"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)' }}
    >
      {/* Mic */}
      <button
        type="button"
        aria-label={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
        aria-pressed={isMicrophoneEnabled}
        onClick={toggleMic}
        className={`${pill} ${isMicrophoneEnabled ? pillEnabled : pillDisabled}`}
      >
        {isMicrophoneEnabled ? (
          <Mic className="w-4 h-4" />
        ) : (
          <MicOff className="w-4 h-4 text-red-400" />
        )}
        Mic
      </button>

      {/* Cam */}
      <button
        type="button"
        aria-label={isCameraEnabled ? 'Turn off camera' : 'Turn on camera'}
        aria-pressed={isCameraEnabled}
        onClick={toggleCam}
        className={`${pill} ${isCameraEnabled ? pillEnabled : pillDisabled}`}
      >
        {isCameraEnabled ? (
          <Video className="w-4 h-4" />
        ) : (
          <VideoOff className="w-4 h-4 text-red-400" />
        )}
        Cam
      </button>

      {/* More */}
      <div className="relative" ref={moreRef}>
        <button
          type="button"
          ref={moreBtnRef}
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={moreOpen ? closeMore : openMore}
          className={`${pill} ${pillEnabled}`}
        >
          <MoreHorizontal className="w-4 h-4" />
          More
        </button>

        {moreOpen && (
          <div
            role="menu"
            aria-label="More actions"
            className="absolute bottom-full right-0 mb-2 rounded-xl py-1.5"
            style={{
              background: 'rgba(0,0,0,0.85)',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              border: '0.5px solid rgba(255,255,255,0.12)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
              minWidth: 180,
            }}
          >
            {items.length === 0 && (
              <div className="text-zinc-500 text-xs text-center px-3 py-2">
                No extra actions available.
              </div>
            )}
            {items.map((it, i) => (
              <button
                key={it.label}
                ref={i === 0 ? firstItemRef : undefined}
                type="button"
                role="menuitem"
                onClick={() => fire(it)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-white hover:bg-white/5 focus:bg-white/5 transition-colors"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
              >
                {it.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Leave */}
      <button
        type="button"
        aria-label="Leave call"
        onClick={onLeave}
        className="rounded-full px-3.5 py-2 text-xs font-medium text-white"
        style={{
          background: '#dc2626',
          boxShadow: '0 0 12px rgba(220,38,38,0.3)',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        Leave
      </button>
    </div>
  );
}
