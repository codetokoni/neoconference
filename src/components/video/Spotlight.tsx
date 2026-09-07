"use client";

import { useEffect, useRef } from "react";
import { useAmsMultitrack } from "./useAmsMultitrack";

interface Spot {
  streamId: string;
  name: string;
  code?: string;
}

/**
 * Fullscreen preview of one participant.
 *
 * Extracted from the cameras board so the name board (and anything else
 * that wants a full-quality look at one child) can reuse the exact same
 * modal without pulling in per-tile WebRTC. Opens one AMS play session
 * on `spot.streamId` for as long as the modal is mounted; closes when
 * `onClose` fires.
 *
 * All action props are optional — pass only the buttons the caller can
 * meaningfully offer. The camera board wires all five (Feature, Send to
 * preview, Monitor audio, Remove, Close); the name board only shows the
 * two producer flows (Feature, Send to preview) plus Close.
 */
export interface SpotlightProps {
  spot: Spot;
  busy?: boolean;
  monitored?: boolean;
  onFeature?: () => void;
  onSendToPreview?: () => void;
  onMonitor?: () => void;
  onRemove?: () => void;
  onClose: () => void;
}

export default function Spotlight({
  spot,
  busy = false,
  monitored = false,
  onFeature,
  onSendToPreview,
  onMonitor,
  onRemove,
  onClose,
}: SpotlightProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const { videoStream } = useAmsMultitrack(spot.streamId, Boolean(spot.streamId));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (videoStream && el.srcObject !== videoStream) {
      el.srcObject = videoStream;
      el.play().catch(() => {});
    }
  }, [videoStream]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black">
      <video ref={ref} playsInline autoPlay className="h-full w-full object-contain" />

      <span className="pointer-events-none absolute left-4 top-4 rounded-md border border-white/15 bg-black/70 px-3 py-1.5 font-mono text-xs text-white/80 backdrop-blur">
        {spot.name} · {spot.streamId}
        {spot.code ? ` · ${spot.code}` : ""}
      </span>

      <button
        type="button"
        aria-label="Close preview"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-black/70 text-lg text-white/85 transition hover:bg-white/10"
      >
        ✕
      </button>

      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 flex-wrap justify-center gap-2 rounded-xl border border-white/15 bg-black/70 p-2 backdrop-blur">
        {onFeature && (
          <button
            type="button"
            disabled={busy}
            onClick={onFeature}
            className="rounded-md bg-amber-500 px-4 py-2 text-sm font-semibold text-[#14100a] transition hover:bg-amber-400 disabled:opacity-40"
          >
            Feature to air
          </button>
        )}
        {onSendToPreview && (
          <button
            type="button"
            disabled={busy}
            onClick={onSendToPreview}
            className="rounded-md border border-emerald-400/60 px-4 py-2 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-500/10 disabled:opacity-40"
          >
            Send to preview
          </button>
        )}
        {onMonitor && (
          <button
            type="button"
            onClick={onMonitor}
            className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/85 transition hover:bg-white/10"
          >
            {monitored ? "Stop monitoring" : "Monitor audio"}
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            className="rounded-md border border-red-500/50 px-4 py-2 text-sm text-red-300 transition hover:bg-red-500/15 disabled:opacity-40"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
