"use client";

import { useEffect, useRef, useState } from "react";
import { useAmsMultitrack } from "./useAmsMultitrack";
import BrandMark from "../BrandMark";

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
  /**
   * Advance to the previous participant without closing the modal.
   * Wire from the parent (NameBoard, ControlRoom, …) so a moderator
   * running a "show each person one after the other" flow can walk
   * the roster with the arrow keys instead of returning to the board
   * between every person. When omitted, ← is a no-op.
   */
  onPrev?: () => void;
  /** Advance to the next participant. When omitted, → is a no-op. */
  onNext?: () => void;
}

export default function Spotlight({ spot, onClose, onPrev, onNext }: SpotlightProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const { videoStream } = useAmsMultitrack(spot.streamId, Boolean(spot.streamId));
  // Silent unless asked: a board opened full screen is usually projected
  // in the hall, where a participant's microphone suddenly playing is
  // unwanted (and echoes). The speaker button or M turns it on.
  const [sound, setSound] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = !sound;
    if (sound) el.play().catch(() => {});
  }, [sound, videoStream]);

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
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "m" || e.key === "M") {
        setSound((on) => !on);
        return;
      }
      // Space also advances so a moderator with a wireless presenter
      // remote (which usually sends PageDown / Space) can step through
      // participants like a slide deck.
      if ((e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") && onNext) {
        e.preventDefault();
        onNext();
        return;
      }
      if ((e.key === "ArrowLeft" || e.key === "PageUp") && onPrev) {
        e.preventDefault();
        onPrev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

  const condition = spot.meta?.condition;
  const country = spot.meta?.country;

  // Only the person on screen (with the logo and the name card): the
  // controls stay hidden until the pointer reaches the top-right corner,
  // or a finger taps the screen; Esc, ← → and M work without them.
  const [tapped, setTapped] = useState(false);
  useEffect(() => {
    if (!tapped) return;
    const t = setTimeout(() => setTapped(false), 3000);
    return () => clearTimeout(t);
  }, [tapped]);
  const controls =
    "flex items-center gap-2 transition-opacity duration-200 " +
    (tapped
      ? "opacity-100"
      : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100");

  // The mouse pointer hides when it stops moving.
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), 2500);
    };
    wake();
    const events = ["pointermove", "pointerdown", "keydown", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, wake, { passive: true }));
    return () => {
      clearTimeout(t);
      events.forEach((e) => window.removeEventListener(e, wake));
    };
  }, []);

  return (
    <div
      className={"fixed inset-0 z-[100] flex items-center justify-center bg-black" + (idle ? " cursor-none" : "")}
      onPointerDown={(e) => {
        if (e.pointerType === "touch") setTapped(true);
      }}
    >
      {/* The camera fills the screen (cropped at the edges if its shape differs). */}
      <video ref={ref} playsInline autoPlay muted className="h-full w-full object-cover" />

      {/* Full screen hides the site header: the logo stays on top. */}
      <BrandMark className="absolute left-4 top-4 z-10" />

      {/* The corner is the hover area: it reaches past the buttons so the
          pointer finds them before it lands on one. */}
      <div data-spot-controls className="group absolute right-0 top-0 pb-12 pl-24 pr-4 pt-4">
        <div className={controls}>
          {onPrev && (
            <button
              type="button"
              aria-label="Previous participant"
              onClick={onPrev}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-black/70 text-lg text-white/85 transition hover:bg-white/10"
            >
              ‹
            </button>
          )}
          {onNext && (
            <button
              type="button"
              aria-label="Next participant"
              onClick={onNext}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-black/70 text-lg text-white/85 transition hover:bg-white/10"
            >
              ›
            </button>
          )}
          <button
            type="button"
            aria-label={sound ? "Turn sound off (M)" : "Turn sound on (M)"}
            title={sound ? "Sound on — click or press M to mute" : "Muted — click or press M to hear this person"}
            aria-pressed={sound}
            onClick={() => setSound((on) => !on)}
            className={
              "flex h-9 w-9 items-center justify-center rounded-md border text-white/85 transition hover:bg-white/10 " +
              (sound ? "border-emerald-400/60 bg-emerald-500/20" : "border-white/15 bg-black/70")
            }
          >
            {sound ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 5 6 9H2v6h4l5 4V5z" />
                <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                <path d="M19 5a10 10 0 0 1 0 14" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 5 6 9H2v6h4l5 4V5z" />
                <path d="m23 9-6 6" />
                <path d="m17 9 6 6" />
              </svg>
            )}
          </button>
          <button
            type="button"
            aria-label="Close preview"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-black/70 text-lg text-white/85 transition hover:bg-white/10"
          >
            ✕
          </button>
        </div>
      </div>

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
