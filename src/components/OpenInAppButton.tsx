"use client";

// "Open in the NeoConference app", for a meeting page opened in a phone's
// browser.
//
// Android opens /e/<slug> and /room/<room> links straight in the app for
// anyone who has it (App Links, mobile/android AndroidManifest.xml). Short
// links — neoconference.app/<slug>, the ones people share most — cannot be
// claimed that way without claiming every page on the site, so they land
// here in the browser. This hands the meeting to the app with an intent
// URL: Chrome opens the app at that meeting if it is installed and stays on
// this page (browser_fallback_url) if it is not.
//
// Only on Android, where the app exists; nothing is drawn elsewhere.

import { useEffect, useState } from "react";

export function appIntentUrl(slug: string, fallback: string): string {
  return (
    "intent://www.neoconference.app/e/" +
    encodeURIComponent(slug) +
    "#Intent;scheme=https;package=app.neoconference;S.browser_fallback_url=" +
    encodeURIComponent(fallback) +
    ";end"
  );
}

export default function OpenInAppButton({ slug }: { slug: string }) {
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    if (!slug || typeof navigator === "undefined") return;
    if (!/Android/i.test(navigator.userAgent)) return;
    setHref(appIntentUrl(slug, window.location.href));
  }, [slug]);

  if (!href) return null;
  return (
    <a
      href={href}
      className="mb-5 flex items-center justify-center gap-2 rounded-2xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-3 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-400/20"
    >
      Open in the NeoConference app
    </a>
  );
}
