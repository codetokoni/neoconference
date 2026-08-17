"use client";

// src/components/SessionBootstrap.tsx
//
// Mints the persistent device session once Clerk reports a signed-in user.
// Mounted in the root layout so it covers both sign-in paths (Clerk directly,
// and KingsChat, which finishes by signing the user into Clerk with a ticket)
// no matter which page they land on afterwards.
//
// Renders nothing and no-ops while signed out.

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

// Never mint a session on the auth pages. Clerk's session JWT stays valid for
// up to a minute after its session is revoked, so a browser bounced here by
// middleware would otherwise immediately mint a fresh persistent session and
// walk straight back in — defeating "sign out everywhere".
const NO_BOOTSTRAP_PREFIXES = ["/sign-in", "/sign-up", "/sign-out"];

export default function SessionBootstrap() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const pathname = usePathname();
  const doneFor = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    if (NO_BOOTSTRAP_PREFIXES.some((p) => pathname?.startsWith(p))) return;
    if (doneFor.current === userId) return;
    doneFor.current = userId;

    const controller = new AbortController();

    fetch("/api/auth/create-session", {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`create-session ${res.status}`);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        doneFor.current = null; // let the next mount retry
        console.error("[SessionBootstrap]", error);
      });

    return () => controller.abort();
  }, [isLoaded, isSignedIn, userId, pathname]);

  return null;
}
