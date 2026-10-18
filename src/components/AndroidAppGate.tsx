"use client";

// On an Android phone, the website hands over to the app: a full-screen
// "Get the NeoConference app" with the LoveWorld AppStore download, and
// "Open in the app" for anyone who has it — at the meeting, when the page
// is one. There is no way to carry on in the browser; that is the point.
// iPhones and computers never see it (lib/appGate.ts says why, and which
// pages stay open on Android).

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import NeoMark from "@/components/NeoMark";
import {
  APP_STORE_URL,
  DOWNLOADED_KEY,
  appOpenUrl,
  gateExempt,
  backToPage,
  isAndroid,
  meetingForGate,
  shouldAutoOpen,
} from "@/lib/appGate";

// A tab the app opened (?from=app) stays open as the reader moves around.
const FROM_APP_KEY = "neo:from-app";
// This tab already tried opening the app by itself; don't loop.
const TRIED_KEY = "neo:app-open-tried";

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
    // Private mode or blocked storage: nothing is remembered, and the
    // screen simply asks again next time.
  }
}

export default function AndroidAppGate() {
  const pathname = usePathname() || "/";
  const [show, setShow] = useState(false);
  const [slug, setSlug] = useState<string | null>(null);
  // Trying to open the app right now (the page leaves if it opens).
  const [trying, setTrying] = useState(false);
  // Where a failed attempt comes back to: this page, marked noapp.
  const [back, setBack] = useState("");

  useEffect(() => {
    if (!isAndroid(navigator.userAgent)) return setShow(false);
    const search = window.location.search;
    if (new URLSearchParams(search).get("from") === "app") {
      write(() => sessionStorage, FROM_APP_KEY);
      // Opened from inside the app: it is installed on this phone.
      write(() => localStorage, DOWNLOADED_KEY);
    }
    if (read(() => sessionStorage, FROM_APP_KEY)) return setShow(false);
    if (gateExempt(pathname, search)) return setShow(false);
    // On /sign-in the meeting is the one it leads back to.
    const meeting = meetingForGate(pathname, search);
    setSlug(meeting);

    const gate = () => {
      setShow(true);
      const fallback = backToPage(window.location.href);
      setBack(fallback);
      const auto = shouldAutoOpen({
        triedThisTab: read(() => sessionStorage, TRIED_KEY),
        search,
        userAgent: navigator.userAgent,
      });
      setTrying(auto);
      if (auto) {
        write(() => sessionStorage, TRIED_KEY);
        // Into the app, at the meeting when this is one. If it does not
        // open, Chrome comes back to this page (never the store), which
        // then offers Open in the app and Download.
        window.location.href = appOpenUrl(meeting, fallback);
      }
    };
    if (!meeting) return gate();

    // The meeting's owner can let phones stay in the browser for it
    // ("Phones open it in the browser"): ask first. Unanswered within 2 s,
    // the usual app screen.
    let cancelled = false;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    fetch("/api/app/gate?slug=" + encodeURIComponent(meeting), { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((j: { browser?: boolean } | null) => {
        clearTimeout(timer);
        if (cancelled) return;
        if (j?.browser) return setShow(false);
        gate();
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ctl.abort();
    };
  }, [pathname]);

  useEffect(() => {
    if (!show) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = before;
    };
  }, [show]);

  if (!show) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-gate-title"
      className="fixed inset-0 z-[2147483000] flex flex-col items-center justify-center overflow-y-auto bg-[#060b1a] px-6 py-10 text-center"
      style={{
        backgroundImage:
          "radial-gradient(ellipse at 85% 0%, rgba(34,211,238,.25), transparent 55%), radial-gradient(ellipse at 0% 100%, rgba(168,85,247,.18), transparent 60%)",
      }}
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-[22px] bg-gradient-to-br from-[#A5FBF9] via-[#56D2FB] to-[#1F66FB] shadow-[0_0_60px_-10px_rgba(34,211,238,0.6)]">
        <NeoMark className="h-9 w-auto" />
      </div>
      <h1 id="app-gate-title" className="mt-6 text-3xl font-bold tracking-tight text-white">
        {trying ? "Opening NeoConference…" : slug ? "Open this meeting in the app" : "Open NeoConference"}
      </h1>
      <p className="mt-3 max-w-sm text-base leading-relaxed text-white/70">
        {trying
          ? "If the app does not open, tap Open in the app below."
          : "Have the NeoConference app? Tap Open in the app. Not yet? Download it free from the LoveWorld AppStore."}
      </p>
      <div className="mt-8 flex w-full max-w-sm flex-col gap-3">
        {/* Open first: most people seeing this already have the app, and a
            big Download button sent them to the store every time. */}
        <a
          href={appOpenUrl(slug, back || APP_STORE_URL)}
          onClick={() => write(() => localStorage, DOWNLOADED_KEY)}
          className="rounded-2xl bg-gradient-to-r from-cyan-400 to-sky-500 px-6 py-4 text-base font-semibold text-slate-900 shadow-[0_0_30px_-8px_rgba(34,211,238,0.6)]"
        >
          {slug ? "Open in the app" : "Open the app"}
        </a>
        <a
          href={APP_STORE_URL}
          className="rounded-2xl border border-cyan-400/40 bg-cyan-400/10 px-6 py-4 text-base font-semibold text-cyan-100"
        >
          Download from LoveWorld AppStore
        </a>
      </div>
      <p className="mt-6 max-w-sm text-xs leading-relaxed text-white/45">
        Free to download. On the store, sign in with KingsChat and tap Download. After installing, come back and tap your meeting link again.
      </p>
    </div>
  );
}
