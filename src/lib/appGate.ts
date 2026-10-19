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
 * The meeting a page leads to: the page itself (meetingSlugFromPath), or,
 * on /sign-in and /sign-up, the meeting its redirect_url goes back to. A
 * signed-out visitor to /testify lands on /sign-in?redirect_url=/testify,
 * and that meeting's settings ("Phones open it in the browser") must
 * still apply there.
 */
export function meetingForGate(pathname: string, search = ""): string | null {
  const own = meetingSlugFromPath(pathname, search);
  if (own) return own;
  const p = pathname.replace(/\/+$/, "");
  if (!/^\/sign-(in|up)(\/|$)/.test(p)) return null;
  const target = new URLSearchParams(search).get("redirect_url");
  if (!target) return null;
  try {
    const u = new URL(target, "https://www.neoconference.app");
    if (!/^(www\.)?neoconference\.app$/.test(u.hostname)) return null;
    return meetingSlugFromPath(u.pathname, u.search);
  } catch {
    return null;
  }
}

/**
 * Remembered on the phone once someone tapped Download, so a later visit
 * goes straight to the app instead of asking again.
 */
export const DOWNLOADED_KEY = "neo:app-downloaded";

/**
 * Added to the page's address when an attempt to open the app came back:
 * the app did not open (not installed, or Chrome would not hand it over),
 * so the page shows its choices instead of trying again.
 */
export const NO_APP_PARAM = "noapp";

/** An app's built-in browser (Android WebView), where intent:// links fail. */
export function isWebView(userAgent: string | null | undefined): boolean {
  return /; wv\)/.test(userAgent || "");
}

/**
 * Whether this visit tries the app straight away. Every Android visit does —
 * a website cannot tell whether the app is installed, and people who had it
 * kept tapping "Download" — except: a visit that is the page coming back
 * from a failed attempt (NO_APP_PARAM), a tab that already tried, and an
 * app's own browser.
 */
export function shouldAutoOpen(input: { triedThisTab: boolean; search: string; userAgent: string }): boolean {
  if (input.triedThisTab || isWebView(input.userAgent)) return false;
  return !new URLSearchParams(input.search).has(NO_APP_PARAM);
}

/**
 * A page to come back to after a failed attempt: this same page, marked so
 * it is not tried again. Never the store: people who had the app were
 * taken to the store every time a link did not open it.
 */
export function backToPage(href: string): string {
  const u = new URL(href);
  u.searchParams.set(NO_APP_PARAM, "1");
  return u.toString();
}

/**
 * Where a phone goes when the app does not open (owner, 2026-10-19: no
 * Download screen; straight to sign-in). Signed out: the sign-in page,
 * leading back to this page. Signed in, or already signing in: this page.
 * Either way marked NO_APP_PARAM, so it is not tried again.
 */
export function noAppFallback(href: string, signedIn: boolean): string {
  const u = new URL(href);
  if (signedIn || /^\/sign-(in|up)(\/|$)/.test(u.pathname)) return backToPage(href);
  const signIn = new URL("/sign-in", u.origin);
  const back = u.pathname + u.search;
  if (back !== "/") signIn.searchParams.set("redirect_url", back);
  signIn.searchParams.set(NO_APP_PARAM, "1");
  return signIn.toString();
}

/**
 * An address Chrome on Android turns into "open the app": at the meeting
 * when there is one (the app claims /e/<slug> links), otherwise its home
 * screen. When the app does not open, Chrome goes to `fallback` —
 * backToPage(), not the store (see there).
 *
 * Home is reached through /app/auth, the sign-in return link: with nothing
 * attached the app simply opens. Chrome only hands a link to an app screen
 * marked BROWSABLE, which the launcher screen is not — the MAIN/LAUNCHER
 * intent this used never opened the app, so neoconference.app/ on a phone
 * with the app always showed "Open or Download" (2026-10-18).
 */
export function appOpenUrl(slug: string | null, fallback: string): string {
  const back = "S.browser_fallback_url=" + encodeURIComponent(fallback);
  const path = slug ? "/e/" + encodeURIComponent(slug) : "/app/auth";
  return `intent://www.neoconference.app${path}#Intent;scheme=https;package=${APP_PACKAGE};${back};end`;
}
