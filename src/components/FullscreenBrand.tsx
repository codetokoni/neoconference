"use client";

// src/components/FullscreenBrand.tsx
//
// Whatever goes full screen — a meeting room, one participant's tile, the
// event player, a display board — the NeoConference logo stays on top of
// it. In full screen the browser draws only the full-screen element and
// what is inside it, so the logo is rendered INTO that element (a portal),
// top-left. Mounted once, in the root layout.
//
// A bare <video> element can't hold children (and phones show their own
// native player then), so nothing is added in that case.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import BrandMark from "./BrandMark";

export default function FullscreenBrand() {
  const [host, setHost] = useState<Element | null>(null);

  useEffect(() => {
    const sync = () => {
      const el = document.fullscreenElement;
      setHost(el && el.tagName !== "VIDEO" && el.tagName !== "AUDIO" ? el : null);
    };
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  if (!host) return null;
  return createPortal(
    <div data-fullscreen-brand className="pointer-events-none fixed left-3 top-3 z-[2147483647]">
      <BrandMark />
    </div>,
    host,
  );
}
