"use client";

import { useEffect, useRef } from "react";
import { useAmsMultitrack } from "./useAmsMultitrack";

interface Spot {
  streamId: string;
  name: string;
  code?: string;
  /**
   * Roster columns uploaded via /video/room/roster. Keys are lowercased
   * header names — `condition`, `country`, `contact` for the SEEN_DOXA
   * shape. Absent when the room never had a roster.
   */
  meta?: Record<string, string>;
}

/**
 * Fullscreen preview of one participant.
 *
 * Attention-first: renders the incoming video edge-to-edge with a name +
 * condition card at the bottom instead of moderator action buttons. The
 * point is inspection — who is this and what should we know about them —
 * not to also be the trigger surface for going to air. Feature-to-air,
 * send-to-preview, monitor and remove all live on the queue board and
 * the tile menus; the Spotlight modal only asks you to look.
 *
 * Opens one AMS play session on `spot.streamId` for as long as the modal
 * is mounted; closes on ✕ or Esc.
 */
export interface SpotlightProps {
  spot: Spot;
  onClose: () => void;
}

export default function Spotlight({ spot, onClose }: SpotlightProps) {
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

  const condition = spot.meta?.condition;
  const country = spot.meta?.country;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black">
      <video ref={ref} playsInline autoPlay className="h-full w-full object-contain" />

      <span className="pointer-events-none absolute left-4 top-4 rounded-md border border-white/15 bg-black/70 px-3 py-1.5 font-mono text-xs text-white/80 backdrop-blur">
        {spot.streamId}
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

      <div className="absolute bottom-6 left-1/2 flex max-w-[min(720px,92vw)] -translate-x-1/2 flex-col items-center gap-2 rounded-xl border border-white/15 bg-black/70 px-6 py-4 text-center backdrop-blur">
        <span className="text-2xl font-bold text-white sm:text-3xl">{spot.name}</span>
        {condition && (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
              Condition
            </span>
            <span className="text-base text-white/90 sm:text-lg">{condition}</span>
          </div>
        )}
        {country && (
          <div className="mt-1 text-xs text-white/70">
            <span className="text-white/45">Country:</span> {country}
          </div>
        )}
      </div>
    </div>
  );
}
