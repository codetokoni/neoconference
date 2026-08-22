"use client";

// src/components/LiveCaptions.tsx
//
// Floating, glassmorphic realtime captions overlay for the live LiveKit room.
//
// Wires into LiveKit's built-in TranscriptionReceived event - any LiveKit
// Agents-based transcription pipeline (Deepgram, Cartesia, etc.) attached to
// the room will surface here automatically. When no transcription stream is
// active, the overlay stays hidden so it never adds visual noise.
//
// Usage: place inside the <LiveKitRoom> tree (where useRoomContext works).
//
//   <LiveKitRoom ...>
//     <VideoConference />
//     <LiveCaptions />
//   </LiveKitRoom>
//
// Activation: requires a transcription provider on the LiveKit side. No-op
// otherwise (the component just won't receive events).

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, type TranscriptionSegment, type Participant, type TrackPublication } from 'livekit-client';
import { CAPTION_LOCALE_STORAGE_KEY } from '@/lib/locales';

type CaptionLine = {
  id: string;
  speaker: string;
  text: string;
  final: boolean;
  receivedAt: number;
};

const MAX_LINES = 4;
const FADE_AFTER_MS = 8000;

// Per-viewer preference (FRS §8.2). Persisted so the choice survives
// reloads — an accessibility win: users who prefer captions off don't
// have to dismiss the panel every meeting.
const HIDDEN_STORAGE_KEY = 'neo:captions-locally-hidden';

// Swipe-to-dismiss thresholds, tuned for phone touchscreens.
const DISMISS_THRESHOLD_PX = 60;
const MAX_DRAG_PX = 220;

export default function LiveCaptions({ enabled = true }: { enabled?: boolean }) {
  const room = useRoomContext();
  const [localeFilter, setLocaleFilter] = useState<string>('auto');
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(CAPTION_LOCALE_STORAGE_KEY);
      if (v) setLocaleFilter(v);
    } catch {}
    const onChange = (e: Event) => {
      const ce = e as CustomEvent<string>;
      if (typeof ce.detail === 'string' && ce.detail) setLocaleFilter(ce.detail);
    };
    window.addEventListener('neo:captions-locale-changed', onChange as EventListener);
    return () => window.removeEventListener('neo:captions-locale-changed', onChange as EventListener);
  }, []);
  const [lines, setLines] = useState<CaptionLine[]>([]);
  const [hasEverReceived, setHasEverReceived] = useState(false);
  // FRS §8.2 per-participant preference. Initialised in an effect (not in
  // useState) so SSR renders the same output as the first client render;
  // reading localStorage during the initial render would create a
  // hydration mismatch.
  const [locallyHidden, setLocallyHidden] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(HIDDEN_STORAGE_KEY) === '1') {
        setLocallyHidden(true);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      if (locallyHidden) window.localStorage.setItem(HIDDEN_STORAGE_KEY, '1');
      else window.localStorage.removeItem(HIDDEN_STORAGE_KEY);
    } catch {}
  }, [locallyHidden]);

  const cleanupTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!room || !enabled) return;

    const handler = (
      segments: TranscriptionSegment[],
      participant?: Participant,
      _publication?: TrackPublication
    ) => {
      setHasEverReceived(true);
      const speakerName =
        participant?.name ||
        participant?.identity ||
        'Speaker';

      setLines((prev) => {
        let next = [...prev];
        for (const seg of segments) {
          if (localeFilter && localeFilter !== 'auto') {
            const segLang = (seg as { language?: string }).language;
            if (segLang && segLang !== localeFilter) continue;
          }
          // LiveKit re-emits non-final segments with the same id while finalizing.
          const idx = next.findIndex((l) => l.id === seg.id);
          const entry: CaptionLine = {
            id: seg.id,
            speaker: speakerName,
            text: seg.text,
            final: seg.final,
            receivedAt: Date.now(),
          };
          if (idx >= 0) next[idx] = entry;
          else next.push(entry);
        }
        // Keep only the last MAX_LINES.
        if (next.length > MAX_LINES) next = next.slice(next.length - MAX_LINES);
        return next;
      });
    };

    room.on(RoomEvent.TranscriptionReceived, handler);

    // Periodically prune lines older than FADE_AFTER_MS that are final.
    cleanupTimer.current = setInterval(() => {
      setLines((prev) => {
        const cutoff = Date.now() - FADE_AFTER_MS;
        return prev.filter((l) => !l.final || l.receivedAt > cutoff);
      });
    }, 1000);

    return () => {
      room.off(RoomEvent.TranscriptionReceived, handler);
      if (cleanupTimer.current) clearInterval(cleanupTimer.current);
      cleanupTimer.current = null;
    };
  }, [room, enabled, localeFilter]);

  // ---------- swipe-down-to-dismiss (mobile) ----------
  // Tracks vertical drag on the caption card. On release, if the user has
  // pulled past DISMISS_THRESHOLD_PX we hide; otherwise we spring back.
  // Touch-only — mouse users have the × button.
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartY = useRef<number | null>(null);
  const dragStartX = useRef<number | null>(null);
  const dragActive = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    dragStartY.current = e.touches[0].clientY;
    dragStartX.current = e.touches[0].clientX;
    dragActive.current = true;
  }, []);
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragActive.current || dragStartY.current == null || dragStartX.current == null) return;
    const dy = e.touches[0].clientY - dragStartY.current;
    const dx = Math.abs(e.touches[0].clientX - dragStartX.current);
    // If the gesture reads more horizontal than vertical, cancel — the user
    // is probably trying to select text or interact with something else.
    if (dx > Math.abs(dy) + 8) {
      dragActive.current = false;
      setDragY(0);
      setIsDragging(false);
      return;
    }
    if (dy > 4 && !isDragging) setIsDragging(true);
    setDragY(Math.max(0, Math.min(dy, MAX_DRAG_PX)));
  }, [isDragging]);
  const onTouchEnd = useCallback(() => {
    if (!dragActive.current) return;
    dragActive.current = false;
    const shouldDismiss = dragY > DISMISS_THRESHOLD_PX;
    setDragY(0);
    setIsDragging(false);
    dragStartY.current = null;
    dragStartX.current = null;
    if (shouldDismiss) setLocallyHidden(true);
  }, [dragY]);

  if (!enabled) return null;
  if (!hasEverReceived || lines.length === 0) return null;
  if (locallyHidden) {
    // Hidden by the viewer. Show a small "Show captions" pill:
    //   • bottom-right corner on mobile (out of the way of the speaker
    //     tile and clear of the control bar via safe-area padding)
    //   • centered above the control bar on desktop (matches where
    //     captions were, so the eye finds it easily)
    return (
      <div
        className="pointer-events-none fixed z-50 right-3 sm:inset-x-0 sm:right-auto sm:bottom-44 sm:flex sm:justify-center sm:px-4"
        style={{ bottom: 'max(env(safe-area-inset-bottom, 0px) + 76px, 96px)' }}
      >
        <button
          type="button"
          onClick={() => setLocallyHidden(false)}
          aria-label="Show captions on this screen"
          title="Show captions on this screen"
          className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-cyan-300/40 bg-black/70 backdrop-blur-xl px-4 py-2.5 text-sm font-medium text-cyan-100 hover:bg-black/80 hover:border-cyan-300/70 active:scale-[0.98] active:bg-black/85 transition shadow-[0_8px_30px_-8px_rgba(0,0,0,0.7),0_0_30px_-15px_rgba(34,211,238,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:px-3 sm:py-1.5 sm:text-[11px]"
        >
          <span className="inline-flex h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_8px_2px_rgba(34,211,238,0.7)] motion-reduce:animate-none sm:h-1.5 sm:w-1.5" />
          <span>Show captions</span>
        </button>
      </div>
    );
  }

  const dragProgress = Math.min(1, dragY / MAX_DRAG_PX);
  const cardStyle: React.CSSProperties = {
    transform: `translateY(${dragY}px)`,
    opacity: 1 - dragProgress * 0.6,
    transition: isDragging ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease',
    touchAction: 'pan-y',
  };

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-3 sm:px-4"
      style={{ bottom: 'max(env(safe-area-inset-bottom, 0px) + 132px, 160px)' }}
    >
      <div
        className="pointer-events-auto max-w-3xl w-full rounded-2xl border border-white/10 bg-black/60 sm:bg-black/55 backdrop-blur-xl shadow-[0_16px_40px_-12px_rgba(0,0,0,0.6),0_0_60px_-20px_rgba(34,211,238,0.4)] px-4 sm:px-5 pt-2 sm:pt-3 pb-3 select-none"
        style={cardStyle}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        {/* iOS-style drag handle — mobile only, signals swipe-down-to-dismiss */}
        <div className="flex justify-center pb-1.5 sm:hidden" aria-hidden>
          <span className="block h-1 w-9 rounded-full bg-white/25" />
        </div>
        <div className="flex items-center gap-2 text-[11px] sm:text-[10px] uppercase tracking-[0.2em] sm:tracking-[0.22em] text-cyan-200/80">
          <span className="inline-flex h-2 w-2 sm:h-1.5 sm:w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_2px_rgba(34,211,238,0.7)] animate-pulse motion-reduce:animate-none" />
          <span className="truncate">Live captions</span>
          <span className="text-white/30" aria-hidden>{'…'}</span>
          <button
            type="button"
            onClick={() => setLocallyHidden(true)}
            aria-label="Hide captions on this screen"
            title="Hide captions on this screen"
            className="ml-auto -mr-1 sm:mr-0 inline-flex items-center justify-center rounded-full w-10 h-10 sm:w-6 sm:h-6 text-xl sm:text-base leading-none text-white/70 hover:text-white/95 hover:bg-white/10 active:bg-white/15 active:scale-95 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
          >
            {'×'}
          </button>
        </div>
        <ul className="mt-2 space-y-1 text-[15px] sm:text-base text-white/95 leading-snug break-words">
          {lines.map((l) => (
            <li key={l.id} className={l.final ? '' : 'text-white/70'}>
              <span className="text-white/60 mr-2 text-xs">{l.speaker}:</span>
              <span>{l.text}</span>
              {!l.final && (
                <span
                  className="ml-1 inline-block w-1.5 h-3 align-baseline bg-cyan-300/80 animate-pulse motion-reduce:animate-none rounded-sm"
                  aria-hidden
                />
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
