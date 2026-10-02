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
import { APP_STORE_URL, appOpenUrl, gateExempt, isAndroid, meetingSlugFromPath } from "@/lib/appGate";

// A tab the app opened (?from=app) stays open as the reader moves around.
const FROM_APP_KEY = "neo:from-app";

export default function AndroidAppGate() {
  const pathname = usePathname() || "/";
  const [show, setShow] = useState(false);
  const [slug, setSlug] = useState<string | null>(null);

  useEffect(() => {
    if (!isAndroid(navigator.userAgent)) return setShow(false);
    const search = window.location.search;
    try {
      if (new URLSearchParams(search).get("from") === "app") sessionStorage.setItem(FROM_APP_KEY, "1");
      if (sessionStorage.getItem(FROM_APP_KEY) === "1") return setShow(false);
    } catch {
      // No storage: the query string alone decides.
    }
    if (gateExempt(pathname, search)) return setShow(false);
    setSlug(meetingSlugFromPath(pathname, search));
    setShow(true);
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
        Get the NeoConference app
      </h1>
      <p className="mt-3 max-w-sm text-base leading-relaxed text-white/70">
        {slug
          ? "This meeting opens in the NeoConference app on Android. Live translation, captions and every meeting tool are there."
          : "On Android, NeoConference is an app. Live translation, captions and every meeting tool are there."}
      </p>
      <div className="mt-8 flex w-full max-w-sm flex-col gap-3">
        <a
          href={APP_STORE_URL}
          className="rounded-2xl bg-gradient-to-r from-cyan-400 to-sky-500 px-6 py-4 text-base font-semibold text-slate-900 shadow-[0_0_30px_-8px_rgba(34,211,238,0.6)]"
        >
          Download from LoveWorld AppStore
        </a>
        <a
          href={appOpenUrl(slug)}
          className="rounded-2xl border border-cyan-400/40 bg-cyan-400/10 px-6 py-4 text-base font-semibold text-cyan-100"
        >
          {slug ? "I have the app — open this meeting" : "I have the app — open it"}
        </a>
      </div>
      <p className="mt-6 max-w-sm text-xs leading-relaxed text-white/45">
        Free to download. After installing, come back and tap your meeting link again.
      </p>
    </div>
  );
}
