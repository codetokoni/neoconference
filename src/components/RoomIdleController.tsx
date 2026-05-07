"use client";

import { useEffect } from "react";

/**
 * Adds `neo-room-idle` to <body> after a period of mouse/keyboard inactivity
 * so that CSS in globals.css can fade out the LiveKit control bar for an
 * immersive, cinematic room view. Auto-cleans on unmount.
 */
export default function RoomIdleController({ delay = 3500 }: { delay?: number }) {
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const wake = () => {
      document.body.classList.remove("neo-room-idle");
      if (t) clearTimeout(t);
      t = setTimeout(() => document.body.classList.add("neo-room-idle"), delay);
    };
    document.body.classList.add("neo-room");
    wake();
    const events: (keyof DocumentEventMap)[] = [
      "mousemove", "mousedown", "keydown", "touchstart", "touchmove", "wheel",
    ];
    events.forEach((e) => document.addEventListener(e, wake, { passive: true }));
    return () => {
      if (t) clearTimeout(t);
      events.forEach((e) => document.removeEventListener(e, wake));
      document.body.classList.remove("neo-room-idle");
      document.body.classList.remove("neo-room");
    };
  }, [delay]);
  return null;
}
