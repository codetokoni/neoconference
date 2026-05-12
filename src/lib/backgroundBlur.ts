/**
 * Background effects for the local camera track.
 *
 * Uses @livekit/track-processors (MediaPipe Selfie Segmentation under the
 * hood). Processor modules are loaded lazily so the MediaPipe WASM/asset
 * bundle is only fetched when the user actually toggles an effect on.
 *
 * Two effects are exposed:
 *   - Blur: soft 10px gaussian blur of the segmented background.
 *   - Image: a still image painted behind the participant.
 *
 * Processors are memoized per "key" so toggling on/off or swapping between
 * the same options doesn't re-download the segmentation model or re-decode
 * the background image.
 *
 * Usage:
 *   import { isEffectsSupported, getProcessor } from "@/lib/backgroundBlur";
 *   if (isEffectsSupported()) {
 *     const proc = await getProcessor({ mode: "blur" });
 *     await videoTrack.setProcessor(proc);
 *   }
 *   // later:
 *   await videoTrack.stopProcessor();
 */

type TrackProcessor = unknown;

export type BackgroundEffect =
  | { mode: "none" }
  | { mode: "blur" }
  | { mode: "image"; url: string };

const cache = new Map<string, TrackProcessor>();

/**
 * Feature-detect whether the browser can run the MediaPipe pipeline that
 * powers background effects. Browsers without MediaStreamTrackProcessor
 * (Safari, older Firefox) fall back to no-op so the UI can hide the toggle.
 */
export function isEffectsSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof (window as any).MediaStreamTrackProcessor === "undefined") return false;
  if (typeof (window as any).OffscreenCanvas === "undefined") return false;
  return true;
}

/**
 * Backwards-compatible alias retained for any external imports.
 */
export const isBlurSupported = isEffectsSupported;

function keyFor(effect: BackgroundEffect): string {
  if (effect.mode === "blur") return "blur:10";
  if (effect.mode === "image") return "image:" + effect.url;
  return "none";
}

/**
 * Lazily import @livekit/track-processors and return a memoized processor
 * for the requested effect. Returns null for { mode: "none" } — callers
 * should call stopProcessor() in that case.
 */
export async function getProcessor(
  effect: BackgroundEffect
): Promise<TrackProcessor | null> {
  if (effect.mode === "none") return null;
  const key = keyFor(effect);
  const hit = cache.get(key);
  if (hit) return hit;
  const mod = await import("@livekit/track-processors");
  let proc: TrackProcessor;
  if (effect.mode === "blur") {
    // 10px is the "soft blur" preset used by Meet/Zoom.
    proc = mod.BackgroundBlur(10);
  } else {
    proc = mod.VirtualBackground(effect.url);
  }
  cache.set(key, proc);
  return proc;
}

/**
 * Backwards-compatible blur-only helper kept for callers that pre-date
 * the multi-effect API.
 */
export async function getBlurProcessor(): Promise<TrackProcessor> {
  const p = await getProcessor({ mode: "blur" });
  return p as TrackProcessor;
}
