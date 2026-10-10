"use client";

import { useEffect, type RefObject } from "react";

const CHECK_MS = 4000;
/** Checks in a row without a new frame before the tile reconnects (~12 s). */
const STALLED_CHECKS = 3;

/**
 * Reconnects a board tile whose picture has stopped.
 *
 * A tile's play session can go silent and stay that way: the publisher
 * reconnects, the tab was frozen in the background, the network blinked.
 * AMS does not always say so, the session never errors, and the tile
 * sits blank on a page that was open for a while while a freshly opened
 * page shows the same cameras fine. While the participant is live and
 * the page is visible, this watches the video's frame count and, when no
 * new frame has arrived for about 12 seconds, calls `restart`.
 */
export function useStallRestart(
  ref: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  restart: () => void,
): void {
  useEffect(() => {
    if (!enabled) return;
    let lastFrames = -1;
    let stalled = 0;
    // A tile scrolled out of view may be paused by the browser; only a tile
    // on screen is judged.
    let onScreen = true;
    const io =
      typeof IntersectionObserver !== "undefined" && ref.current
        ? new IntersectionObserver(([e]) => {
            onScreen = e?.isIntersecting ?? true;
          })
        : null;
    if (io && ref.current) io.observe(ref.current);

    const frames = (el: HTMLVideoElement) =>
      el.getVideoPlaybackQuality?.().totalVideoFrames ?? Math.floor(el.currentTime * 30);

    const check = () => {
      const el = ref.current;
      if (!el || document.hidden || !onScreen) {
        // A hidden page or tile draws no frames; judge it again once shown.
        stalled = 0;
        lastFrames = -1;
        return;
      }
      if (el.srcObject && el.paused) el.play().catch(() => {});
      const now = el.srcObject ? frames(el) : -1;
      if (now >= 0 && now !== lastFrames) {
        stalled = 0;
      } else {
        stalled += 1;
      }
      lastFrames = now;
      if (stalled >= STALLED_CHECKS) {
        stalled = 0;
        lastFrames = -1;
        restart();
      }
    };

    const timer = setInterval(check, CHECK_MS);
    return () => {
      clearInterval(timer);
      io?.disconnect();
    };
  }, [ref, enabled, restart]);
}
