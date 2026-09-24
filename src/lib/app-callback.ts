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
// ticket there instead. The start routes otherwise relay only same-origin
// relative paths, and that guard stays exactly as strict as it was — this is
// one literal string, compared whole, never a pattern.
//
// That destination is an Android App Link, not a custom scheme. Android
// hands an https URL to an app only after fetching
// /.well-known/assetlinks.json from this domain and confirming the installed
// app is signed by the certificate named there, so no other app can claim
// it. A custom scheme has no such check, and what travels on this link is a
// Clerk sign-in ticket — a hijack would be an account takeover.

const CANONICAL_ORIGIN = 'https://www.neoconference.app';

export const APP_LINK_PATH = '/app/auth';
export const APP_LINK = `${CANONICAL_ORIGIN}${APP_LINK_PATH}`;

/** True when the sign-in was started by the mobile app. */
export function isAppCallback(raw: string | null | undefined): boolean {
  return (raw || '').trim() === APP_LINK;
}

/**
 * Relays a value the caller asked to come back to.
 *
 * Accepts a same-origin relative path, or the app's one destination, and
 * nothing else — an absolute or protocol-relative URL would make the route
 * an open redirect.
 */
export function safeRelay(raw: string | null | undefined): string {
  const value = (raw || '').trim();
  if (isAppCallback(value)) return value;
  return value.startsWith('/') && !value.startsWith('//') ? value : '';
}

/**
 * Sends the browser into the app.
 *
 * A 303 keeps the method a GET, matching the redirects around it.
 */
export function redirectToApp(params: Record<string, string>): NextResponse {
  const url = new URL(APP_LINK);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url, { status: 303 });
}
