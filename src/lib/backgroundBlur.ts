/**
 * Background blur for the local camera track.
 *
 * Uses @livekit/track-processors (MediaPipe Selfie Segmentation under the
 * hood). The processor module is loaded lazily so the MediaPipe WASM/asset
 * bundle is only fetched when the user actually toggles blur on.
 *
 * Usage:
 *   import { isBlurSupported, getBlurProcessor } from "@/lib/backgroundBlur";
 *   if (isBlurSupported()) {
 *     const proc = await getBlurProcessor();
 *     await videoTrack.setProcessor(proc);
 *   }
 *   // later:
 *   await videoTrack.stopProcessor();
 */

type TrackProcessor = unknown;

let cached: TrackProcessor | null = null;

/**
 * Feature-detect whether the browser can run the MediaPipe pipeline that
 * powers background blur. Browsers without MediaStreamTrackProcessor (Safari,
 * older Firefox) fall back to no-op so the UI can hide the toggle.
 */
export function isBlurSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof (window as any).MediaStreamTrackProcessor === "undefined") return false;
  if (typeof (window as any).OffscreenCanvas === "undefined") return false;
  return true;
}

/**
 * Lazily import @livekit/track-processors and return a memoized
 * BackgroundBlur processor. The same instance is reused across toggles so
 * we don't re-download the segmentation model on every enable.
 */
export async function getBlurProcessor(): Promise<TrackProcessor> {
  if (cached) return cached;
  const mod = await import("@livekit/track-processors");
  // BackgroundBlur(radius) — 10px is the "soft blur" preset used by Meet/Zoom.
  cached = mod.BackgroundBlur(10);
  return cached;
}
