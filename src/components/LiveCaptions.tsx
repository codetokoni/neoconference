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

import { useEffect, useState, useRef } from 'react';
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
  // FRS §8.2 per-participant preference: even when the host has captions
  // available and the worker is emitting segments, a participant can hide
  // the display on their own screen. Session-only (no persistence across
  // reloads); a floating "Show captions" pill lets them bring the panel
  // back without a refresh.
  const [locallyHidden, setLocallyHidden] = useState(false);
  const cleanupTimer = useRef
<ReturnType<typeof setInterval> | null>(null);

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

  if (!enabled) return null;
  if (!hasEverReceived || lines.length === 0) return null;
  if (locallyHidden) {
    // Hidden by the user for this session. Render a small "Show captions"
    // pill so they can bring the panel back without refreshing.
    return (
      <div
        className="pointer-events-none fixed inset-x-0 bottom-40 sm:bottom-44 z-50 flex justify-center px-4"
      >
        <button
          type="button"
          onClick={() => setLocallyHidden(false)}
          aria-label="Show captions on this screen"
          title="Show captions on this screen"
          className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-cyan-300/40 bg-black/60 backdrop-blur-xl px-3 py-1.5 text-[11px] font-medium text-cyan-200 hover:bg-black/75 hover:border-cyan-300/70 transition shadow-[0_0_30px_-15px_rgba(34,211,238,0.6)]"
        >
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_2px_rgba(34,211,238,0.7)]" />
          Show captions
        </button>
      </div>
    );
  }

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-40 sm:bottom-44 z-50 flex justify-center px-4"
    >
      <div className="max-w-3xl w-full rounded-2xl border border-white/10 bg-black/55 backdrop-blur-xl shadow-[0_0_60px_-20px_rgba(34,211,238,0.4)] px-4 sm:px-5 py-3">
        <div className="pointer-events-auto flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-cyan-200/80">
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_2px_rgba(34,211,238,0.7)] animate-pulse" />
          Live captions
          <span className="text-white/30">{'\u2026'}</span>
          <button
            type="button"
            onClick={() => setLocallyHidden(true)}
            aria-label="Hide captions on this screen"
            title="Hide captions on this screen"
            className="ml-auto text-white/50 hover:text-white/90 text-base leading-none px-1"
          >
            {'\u00d7'}
          </button>
        </div>
        <ul className="mt-2 space-y-1 text-sm sm:text-base text-white/90 leading-snug">
          {lines.map((l) => (
            <li key={l.id} className={l.final ? '' : 'text-white/70'}>
              <span className="text-white/55 mr-2 text-xs">{l.speaker}:</span>
              <span>{l.text}</span>
              {!l.final && <span className="ml-1 inline-block w-1.5 h-3 align-baseline bg-cyan-300/80 animate-pulse rounded-sm" />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
