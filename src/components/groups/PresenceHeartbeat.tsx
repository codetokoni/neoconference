"use client";

// "I'm in this meeting", every 60 s while the room is connected, and "I left"
// on the way out (src/lib/presence.ts). The ring engine reads it so nobody is
// rung into a meeting they are already in, or rung over another meeting.
// Mounted inside <LiveKitRoom>. Renders nothing.

import { useEffect } from "react";

const EVERY_MS = 60_000;

export default function PresenceHeartbeat({ eventSlug }: { eventSlug: string }) {
  useEffect(() => {
    if (!eventSlug) return;
    const here = () =>
      fetch("/api/me/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventSlug }),
      }).catch(() => undefined);
    // keepalive lets the request finish while the page is closing.
    const gone = () => fetch("/api/me/presence", { method: "DELETE", keepalive: true }).catch(() => undefined);

    void here();
    const id = window.setInterval(here, EVERY_MS);
    window.addEventListener("pagehide", gone);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("pagehide", gone);
      void gone();
    };
  }, [eventSlug]);

  return null;
}
