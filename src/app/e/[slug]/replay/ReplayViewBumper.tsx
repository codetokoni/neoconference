'use client';

// src/app/e/[slug]/replay/ReplayViewBumper.tsx
//
// Fires a single view-counter bump on mount for a given recording key,
// gated by sessionStorage so the same browser tab does not double-count.
// Best-effort, fire-and-forget. Renders nothing.

import { useEffect } from "react";

type Props = { recordingKey: string };

export default function ReplayViewBumper({ recordingKey }: Props) {
  useEffect(() => {
    if (!recordingKey) return;
    try {
      const flag = "neo:viewed:" + recordingKey;
      if (typeof window !== "undefined" && window.sessionStorage.getItem(flag)) return;
      window.sessionStorage.setItem(flag, "1");
    } catch {
      // ignore storage errors and still bump
    }
    fetch("/api/recordings/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metric: "views", key: recordingKey }),
      keepalive: true,
    }).catch(() => {});
  }, [recordingKey]);
  return null;
}
