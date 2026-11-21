// When the zone embed's prayer timer beats (PrayerTimer.tsx): at once, then
// every PAGE_BEAT_MS while the page is on screen and every
// HIDDEN_PAGE_BEAT_MS while it is hidden, and at once again when it comes
// back on screen. Kept apart from the component so a test can drive it with
// a fake clock and a fake document.

import { HIDDEN_PAGE_BEAT_MS, PAGE_BEAT_MS } from "@/lib/partners/attendanceMath";

type Clock = { setInterval(fn: () => void, ms: number): number; clearInterval(id: number): void };
type Page = {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
};

/** Starts beating; the returned function stops it. */
export function startBeating(beat: () => void, clock: Clock = window, page: Page = document): () => void {
  let id = 0;
  const schedule = () => {
    clock.clearInterval(id);
    id = clock.setInterval(beat, page.visibilityState === "hidden" ? HIDDEN_PAGE_BEAT_MS : PAGE_BEAT_MS);
  };
  const onVisibility = () => {
    if (page.visibilityState === "visible") beat();
    schedule();
  };
  beat();
  schedule();
  page.addEventListener("visibilitychange", onVisibility);
  return () => {
    clock.clearInterval(id);
    page.removeEventListener("visibilitychange", onVisibility);
  };
}
