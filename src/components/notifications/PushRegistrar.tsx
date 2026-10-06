"use client";

// Registers the service worker for signed-in people and keeps the server's
// copy of this browser's push subscription current. Never asks for
// permission — that only happens from the "Turn on call alerts" button.
//
// Also relays what the worker says to the page: a push arrived (the bell
// refreshes), or a notification was clicked for a tab the worker cannot
// navigate itself.
//
// Mounted in the root layout next to SessionBootstrap. Renders nothing.

import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { NOTIFICATIONS_CHANGED, registration, syncAlerts } from "@/lib/pushClient";

export default function PushRegistrar() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const doneFor = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const onMessage = (e: MessageEvent) => {
      const data = e.data as { kind?: string; url?: string; payload?: unknown } | null;
      if (data?.kind === "neo-push") {
        // The payload rides along: the call overlay acts on rings at once.
        window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED, { detail: data.payload }));
      } else if (data?.kind === "neo-navigate" && typeof data.url === "string") {
        const url = new URL(data.url, window.location.origin);
        if (url.origin === window.location.origin) window.location.assign(url.href);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    if (doneFor.current !== userId) {
      doneFor.current = userId;
      void (async () => {
        await registration();
        await syncAlerts().catch((err) => console.warn("[push] sync failed", err));
      })();
    }
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [isLoaded, isSignedIn, userId]);

  return null;
}
