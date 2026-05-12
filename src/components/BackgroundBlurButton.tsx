"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocalParticipant } from "@livekit/components-react";
import { Track, type LocalVideoTrack } from "livekit-client";
import { isBlurSupported, getBlurProcessor } from "@/lib/backgroundBlur";

const STORAGE_KEY = "neo:bg-blur";

/**
 * BackgroundBlurButton
 *
 * Toolbar toggle for applying a privacy blur to the local camera feed.
 * Rendered inside <LiveKitRoom> so useLocalParticipant resolves.
 *
 * Behavior:
 * - Hidden entirely on browsers without MediaStreamTrackProcessor (Safari/iOS).
 * - State is persisted to localStorage under "neo:bg-blur" and restored next
 *   time the camera publishes.
 * - Errors are swallowed silently and the toggle resets to off — a failed
 *   blur should never break the call.
 */
export default function BackgroundBlurButton() {
  const supported = isBlurSupported();
  const { localParticipant } = useLocalParticipant();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  // Restore persisted preference on mount.
  useEffect(() => {
    if (!supported) return;
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v === "1") setEnabled(true);
    } catch {
      // localStorage may throw in private mode — ignore.
    }
  }, [supported]);

  // Apply / remove the processor whenever `enabled` or the published camera track changes.
  useEffect(() => {
    if (!supported || !localParticipant) return;
    let cancelled = false;

    const apply = async () => {
      const pub = localParticipant.getTrackPublication(Track.Source.Camera);
      const track = pub?.videoTrack as LocalVideoTrack | undefined;
      if (!track) return;
      try {
        if (enabled) {
          const proc = await getBlurProcessor();
          if (cancelled) return;
          await track.setProcessor(proc as any);
        } else {
          await track.stopProcessor();
        }
      } catch (e) {
        // If anything goes wrong (model fetch, GPU init, etc.) reset to off
        // so the user keeps an unblurred but working video feed.
        console.warn("background blur failed", e);
        if (!cancelled) setEnabled(false);
      }
    };

    apply();
    return () => {
      cancelled = true;
    };
  }, [enabled, supported, localParticipant]);

  // Persist preference.
  useEffect(() => {
    if (!supported) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      // ignore
    }
  }, [enabled, supported]);

  const onClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setEnabled((v) => !v);
    // Brief debounce so rapid clicks don't fire overlapping setProcessor calls.
    setTimeout(() => setBusy(false), 400);
  }, [busy]);

  if (!supported) return null;

  return (
    <button
      type="button"
      data-room-chrome="true"
      onClick={onClick}
      aria-pressed={enabled}
      disabled={busy}
      className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
      title={enabled ? "Turn off background blur" : "Blur your background"}
    >
      {enabled ? "Blur on" : "Blur off"}
    </button>
  );
}
