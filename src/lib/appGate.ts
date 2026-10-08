// src/lib/appGate.ts
//
// On an Android phone the website asks for the app instead: NeoConference
// on Android is the app, from the LoveWorld AppStore. iPhones and computers
// keep the website — the app is Android-only, and a gate there would lock
// them out of NeoConference altogether.
//
// Pure, so it can be tested without a browser; components/AndroidAppGate.tsx
// draws it.

import { RESERVED_SHORT_URL_SLUGS } from "@/lib/reservedSlugs";

/** NeoConference on the LoveWorld AppStore. */
export const APP_STORE_URL = "https://web.lwappstore.com/share/lW-APP-Y26-XG9328";

/** The app's Android package. */
export const APP_PACKAGE = "app.neoconference";

export function isAndroid(userAgent: string | null | undefined): boolean {
  return /Android/i.test(userAgent || "");
}

/**
 * Pages an Android phone still gets, because the app needs them or cannot
 * do what they do:
 *   /app/*           where a sign-in or payment comes back to the app
 *   /support         the app opens it inside itself (Help & support)
 *   /e/<slug>/replay the app does not play recordings
 *   /embed/*         a meeting shown inside someone else's website
 *   /admin/*         operators' tools, which the app does not have
 *   /video/*         the live-event broadcast (join with a participant
 *                    code, the programme player, its dashboard and
 *                    studio); the app has none of it, so sending an
 *                    Android visitor there to the app stranded them
 *   /sign-out        must run its clean-up whatever the device
 *   /sign-in, /sign-up  when they lead back to a /video/ page
 * and any page the app itself opened (?from=app), or a sign-in carrying a
 * ticket from the app's own sign-in.
 */
export function gateExempt(pathname: string, search = ""): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (/^\/(app|embed|admin|video)(\/|$)/.test(p)) return true;
  if (p === "/support" || p === "/sign-out") return true;
  if (/^\/e\/[^/]+\/replay$/.test(p)) return true;
  const q = new URLSearchParams(search);
  if (q.get("from") === "app") return true;
  if (q.has("__clerk_ticket")) return true;
  // Signing in (or up) on the way to a /video/ page: the operator pages
  // need a signed-in account, and the middleware sends a signed-out
  // visitor to /sign-in?redirect_url=<page>. Gating that sent an Android
  // operator to the AppStore from every one of them (8 Oct 2026).
  if (/^\/sign-(in|up)(\/|$)/.test(p) && headsForVideo(q.get("redirect_url"))) return true;
  return false;
}

/** A redirect_url that lands on one of this site's /video/ pages. */
function headsForVideo(target: string | null): boolean {
  if (!target) return false;
  try {
    const u = new URL(target, "https://www.neoconference.app");
    if (!/^(www\.)?neoconference\.app$/.test(u.hostname)) return false;
    return /^\/video(\/|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * The meeting a page is for, when it is one: /e/<slug>, /room/<room>
 * (with ?event=<slug> when the room and the meeting differ), or a short
 * link /<slug>. Null for every other page.
 */
export function meetingSlugFromPath(pathname: string, search = ""): string | null {
  const p = pathname.replace(/\/+$/, "");
  const e = /^\/e\/([^/]+)$/.exec(p);
  if (e) return decodeURIComponent(e[1]);
  const room = /^\/room\/([^/]+)$/.exec(p);
  if (room) return new URLSearchParams(search).get("event") || decodeURIComponent(room[1]);
  const short = /^\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/.exec(p);
  if (short && !RESERVED_SHORT_URL_SLUGS.has(short[1])) return short[1];
  return null;
}

/**
 * Remembered on the phone once someone tapped Download, so a later visit
 * goes straight to the app instead of asking again.
 */
export const DOWNLOADED_KEY = "neo:app-downloaded";

/**
 * Whether this visit should try the app straight away: they downloaded it
 * before, and this is not the visit straight back from a failed attempt
 * (the store fallback lands on the store, so coming back here at all means
 * the app did not open — then the screen is shown, not another attempt).
 */
export function shouldAutoOpen(downloadedBefore: boolean, triedThisTab: boolean): boolean {
  return downloadedBefore && !triedThisTab;
}

/**
 * An address Chrome on Android turns into "open the app": at the meeting
 * when there is one (the app claims /e/<slug> links), otherwise at its
 * start screen. Without the app installed, Chrome goes to the store.
 */
export function appOpenUrl(slug: string | null, fallback = APP_STORE_URL): string {
  const back = "S.browser_fallback_url=" + encodeURIComponent(fallback);
  if (slug) {
    return (
      "intent://www.neoconference.app/e/" +
      encodeURIComponent(slug) +
      `#Intent;scheme=https;package=${APP_PACKAGE};${back};end`
    );
  }
  return `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${APP_PACKAGE};${back};end`;
}
