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
  isAndroid,
  meetingSlugFromPath,
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
  // Downloaded before on this phone: open the app instead of asking.
  const [returning, setReturning] = useState(false);

  useEffect(() => {
    if (!isAndroid(navigator.userAgent)) return setShow(false);
    const search = window.location.search;
    if (new URLSearchParams(search).get("from") === "app") write(() => sessionStorage, FROM_APP_KEY);
    if (read(() => sessionStorage, FROM_APP_KEY)) return setShow(false);
    if (gateExempt(pathname, search)) return setShow(false);
    const meeting = meetingSlugFromPath(pathname, search);
    setSlug(meeting);
    setShow(true);

    const downloaded = read(() => localStorage, DOWNLOADED_KEY);
    setReturning(downloaded);
    if (shouldAutoOpen(downloaded, read(() => sessionStorage, TRIED_KEY))) {
      write(() => sessionStorage, TRIED_KEY);
      // Into the app, at the meeting when this is one. Without the app,
      // Chrome follows the fallback to the store.
      window.location.href = appOpenUrl(meeting);
    }
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
        {returning ? "Opening NeoConference…" : "Get the NeoConference app"}
      </h1>
      <p className="mt-3 max-w-sm text-base leading-relaxed text-white/70">
        {returning
          ? "If the app did not open, tap below."
          : slug
            ? "This meeting opens in the NeoConference app on Android. Live translation, captions and every meeting tool are there."
            : "On Android, NeoConference is an app. Live translation, captions and every meeting tool are there."}
      </p>
      <div className={"mt-8 flex w-full max-w-sm gap-3 " + (returning ? "flex-col-reverse" : "flex-col")}>
        <a
          href={APP_STORE_URL}
          // Remembered, so the next visit opens the app instead of asking.
          onClick={() => write(() => localStorage, DOWNLOADED_KEY)}
          className={
            returning
              ? "rounded-2xl border border-white/15 px-6 py-3 text-sm font-semibold text-white/70"
              : "rounded-2xl bg-gradient-to-r from-cyan-400 to-sky-500 px-6 py-4 text-base font-semibold text-slate-900 shadow-[0_0_30px_-8px_rgba(34,211,238,0.6)]"
          }
        >
          {returning ? "Download the app again" : "Download from LoveWorld AppStore"}
        </a>
        <a
          href={appOpenUrl(slug)}
          // Opening it from here also says they have it.
          onClick={() => write(() => localStorage, DOWNLOADED_KEY)}
          className={
            returning
              ? "rounded-2xl bg-gradient-to-r from-cyan-400 to-sky-500 px-6 py-4 text-base font-semibold text-slate-900 shadow-[0_0_30px_-8px_rgba(34,211,238,0.6)]"
              : "rounded-2xl border border-cyan-400/40 bg-cyan-400/10 px-6 py-4 text-base font-semibold text-cyan-100"
          }
        >
          {returning
            ? slug
              ? "Open this meeting in the app"
              : "Open the app"
            : slug
              ? "I have the app — open this meeting"
              : "I have the app — open it"}
        </a>
      </div>
      {returning ? null : (
        <p className="mt-6 max-w-sm text-xs leading-relaxed text-white/45">
          Free to download. After installing, come back and tap your meeting link again.
        </p>
      )}
    </div>
  );
}
