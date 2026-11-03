"use client";

// src/components/SessionBootstrap.tsx
//
// Mints the persistent device session once Clerk reports a signed-in user.
// Mounted in the root layout so it covers both sign-in paths (Clerk directly,
// and KingsChat, which finishes by signing the user into Clerk with a ticket)
// no matter which page they land on afterwards.
//
// Renders nothing. Also tells a browser signed out from another device why
// (useSignedOutElsewhere).

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth, useClerk } from "@clerk/nextjs";

// Never mint a session on the auth pages. Clerk's session JWT stays valid for
// up to a minute after its session is revoked, so a browser bounced here by
// middleware would otherwise immediately mint a fresh persistent session and
// walk straight back in — defeating "sign out everywhere".
const NO_BOOTSTRAP_PREFIXES = ["/sign-in", "/sign-up", "/sign-out"];

// The Clerk session this browser last held, so that once it is gone the page
// can ask why (src/lib/deviceSessions.ts) — after a reload too.
const LAST_SESSION_KEY = "neo:last-session";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function signedOutReason(sessionId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/auth/signed-out-reason?session=${encodeURIComponent(sessionId)}`, {
      cache: "no-store",
    });
    const body = (await res.json()) as { reason?: string | null };
    return body.reason ?? null;
  } catch {
    return null;
  }
}

/**
 * Says why this browser was signed out when another device ended its
 * session ("…signed in on another device"), instead of leaving the person
 * on a page that quietly stopped working. Only a session the server marked
 * as signed out elsewhere does this: a sign-out here, a network blip or a
 * hidden tab never does (Clerk only ends a session that was revoked).
 */
function useSignedOutElsewhere() {
  const { isLoaded, isSignedIn, sessionId } = useAuth();
  const { signOut } = useClerk();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoaded) return;
    const store = storage();
    if (isSignedIn && sessionId) {
      // On the sign-in page a revoked session's token can still read as
      // signed in for up to a minute; end it here so the page is usable.
      if (pathname?.startsWith("/sign-in")) {
        void signedOutReason(sessionId).then((reason) => {
          if (reason) void signOut({ redirectUrl: `/sign-in?signed_out=${reason}` });
        });
        return;
      }
      store?.setItem(LAST_SESSION_KEY, sessionId);
      return;
    }
    const last = store?.getItem(LAST_SESSION_KEY);
    if (!last) return;
    store?.removeItem(LAST_SESSION_KEY);
    void signedOutReason(last).then((reason) => {
      if (!reason) return;
      if (new URLSearchParams(window.location.search).get("signed_out") === reason) return;
      window.location.assign(`/sign-in?signed_out=${reason}`);
    });
  }, [isLoaded, isSignedIn, sessionId, pathname, signOut]);
}

export default function SessionBootstrap() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const pathname = usePathname();
  const doneFor = useRef<string | null>(null);
  useSignedOutElsewhere();

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
