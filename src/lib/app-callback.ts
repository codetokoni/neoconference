import { NextResponse } from 'next/server';

// Handing a sign-in back to the mobile app.
//
// The KingsChat and Neomail callbacks finish by minting a short-lived Clerk
// sign-in ticket and redirecting to /sign-in with it. That is right for a
// browser, where /sign-in has a Clerk session to put the ticket into. The
// mobile app has no browser session: it needs the ticket itself, so it can
// redeem it against Clerk's Frontend API and hold the session on the phone.
//
// So the app asks for one specific destination and the callbacks send the
// ticket there instead. Both start routes otherwise relay only same-origin
// relative paths, and that guard stays exactly as strict as it was — these
// are literal strings, compared whole, never patterns.
//
// Two destinations exist, and the difference matters:
//
//   * APP_LINK is an Android App Link. Android only hands an https URL to
//     an app after checking /.well-known/assetlinks.json on this domain and
//     confirming the installed app is signed by the certificate named there.
//     No other app can claim it. This is what the app asks for.
//
//   * APP_CALLBACK is the old custom scheme. Any app on the phone may
//     register `neoconference://`, so a malicious one could receive a
//     sign-in ticket and take over the account. It is still accepted here
//     only so that a build already installed on someone's phone keeps
//     working; remove it once no such build is in use.

const CANONICAL_ORIGIN = 'https://www.neoconference.app';

export const APP_LINK_PATH = '/app/auth';
export const APP_LINK = `${CANONICAL_ORIGIN}${APP_LINK_PATH}`;

/** @deprecated Hijackable by any app. See above. */
export const APP_CALLBACK = 'neoconference://auth';

/** True when the sign-in was started by the mobile app. */
export function isAppCallback(raw: string | null | undefined): boolean {
  const value = (raw || '').trim();
  return value === APP_LINK || value === APP_CALLBACK;
}

/**
 * Relays a value the caller asked to come back to.
 *
 * Accepts a same-origin relative path, or one of the app's two exact
 * destinations, and nothing else — an absolute or protocol-relative URL
 * would make the route an open redirect.
 */
export function safeRelay(raw: string | null | undefined): string {
  const value = (raw || '').trim();
  if (isAppCallback(value)) return value;
  return value.startsWith('/') && !value.startsWith('//') ? value : '';
}

/**
 * Sends the browser into the app.
 *
 * `target` is whichever destination the caller originally asked for, so a
 * phone running an older build still gets the custom scheme it registered.
 * Built by hand rather than with NextResponse.redirect, which expects an
 * http(s) URL and would reject the custom scheme. A 303 keeps the method a
 * GET, matching the redirects around it.
 */
export function redirectToApp(
  params: Record<string, string>,
  target: string = APP_LINK,
): NextResponse {
  const url = new URL(isAppCallback(target) ? target : APP_LINK);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextResponse(null, {
    status: 303,
    headers: { Location: url.toString() },
  });
}
