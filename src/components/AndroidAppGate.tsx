"use client";

// On an Android phone, a link to the website first tries the app — at the
// meeting, when the page is one. If the app does not open, the phone goes
// straight to sign-in (or, signed in, stays on the page): there is no
// "Download" screen (owner, 2026-10-19). iPhones and computers never see
// this (lib/appGate.ts says why, and which pages stay open on Android).

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import NeoMark from "@/components/NeoMark";
import {
  DOWNLOADED_KEY,
  appOpenUrl,
  gateExempt,
  isAndroid,
  isWebView,
  meetingForGate,
  noAppFallback,
  NO_APP_PARAM,
  shouldAutoOpen,
} from "@/lib/appGate";

// A tab the app opened (?from=app) stays open as the reader moves around.
const FROM_APP_KEY = "neo:from-app";
// This tab already tried opening the app by itself; don't loop.
const TRIED_KEY = "neo:app-open-tried";
// Chrome leaves for the app or goes to the fallback within a moment. A
// browser that does neither (it ignores intent links) is sent on by hand.
const GIVE_UP_MS = 2500;

function read(storage: () => Storage, key: string): boolean {
  try {
    return storage().getItem(key) === "1";
  } catch {
    return false;
  }
}

function write(storage: () => Storage, key: string) {
  try {
    storage().setItem(key, "1");
  } catch {
    // Private mode or blocked storage: nothing is remembered.
  }
}

export default function AndroidAppGate() {
  const pathname = usePathname() || "/";
  const { isLoaded, isSignedIn } = useAuth();
  // "Opening NeoConference…" while the app is being tried.
  const [trying, setTrying] = useState(false);

  useEffect(() => {
    if (!isAndroid(navigator.userAgent) || !isLoaded) return;
    const search = window.location.search;
    if (new URLSearchParams(search).get("from") === "app") {
      write(() => sessionStorage, FROM_APP_KEY);
      // Opened from inside the app: it is installed on this phone.
      write(() => localStorage, DOWNLOADED_KEY);
    }
    if (read(() => sessionStorage, FROM_APP_KEY)) return;
    if (gateExempt(pathname, search)) return;
    const triedThisTab = read(() => sessionStorage, TRIED_KEY);
    if (triedThisTab || new URLSearchParams(search).has(NO_APP_PARAM)) return;
    // On /sign-in the meeting is the one it leads back to.
    const meeting = meetingForGate(pathname, search);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      if (cancelled) return;
      write(() => sessionStorage, TRIED_KEY);
      const fallback = noAppFallback(window.location.href, !!isSignedIn);
      // An app's own browser (WebView) cannot open the app: on to sign-in.
      if (isWebView(navigator.userAgent)) return window.location.replace(fallback);
      if (!shouldAutoOpen({ triedThisTab, search, userAgent: navigator.userAgent })) return;
      setTrying(true);
      let left = false;
      const away = () => {
        if (document.visibilityState === "hidden") left = true;
      };
      document.addEventListener("visibilitychange", away);
      // Into the app. If it does not open, Chrome goes to the fallback.
      window.location.href = appOpenUrl(meeting, fallback);
      timer = setTimeout(() => {
        document.removeEventListener("visibilitychange", away);
        if (cancelled) return;
        // The app opened: whoever comes back to this tab sees the page.
        if (left) return setTrying(false);
        window.location.replace(fallback);
      }, GIVE_UP_MS);
    };
    if (!meeting) {
      go();
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }

    // The meeting's owner can let phones stay in the browser for it
    // ("Phones open it in the browser"): ask first. Unanswered within 2 s,
    // the app is tried as usual.
    const ctl = new AbortController();
    const ask = setTimeout(() => ctl.abort(), 2000);
    fetch("/api/app/gate?slug=" + encodeURIComponent(meeting), { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((j: { browser?: boolean } | null) => {
        clearTimeout(ask);
        if (cancelled || j?.browser) return;
        go();
      });
    return () => {
      cancelled = true;
      clearTimeout(ask);
      clearTimeout(timer);
      ctl.abort();
    };
  }, [pathname, isLoaded, isSignedIn]);

  useEffect(() => {
    if (!trying) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = before;
    };
  }, [trying]);

  if (!trying) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-gate-title"
      className="fixed inset-0 z-[2147483000] flex flex-col items-center justify-center bg-[#060b1a] px-6 py-10 text-center"
      style={{
        backgroundImage:
          "radial-gradient(ellipse at 85% 0%, rgba(34,211,238,.25), transparent 55%), radial-gradient(ellipse at 0% 100%, rgba(168,85,247,.18), transparent 60%)",
      }}
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-[22px] bg-gradient-to-br from-[#A5FBF9] via-[#56D2FB] to-[#1F66FB] shadow-[0_0_60px_-10px_rgba(34,211,238,0.6)]">
        <NeoMark className="h-9 w-auto" />
      </div>
      <h1 id="app-gate-title" className="mt-6 text-3xl font-bold tracking-tight text-white">
        Opening NeoConference…
      </h1>
    </div>
  );
}
