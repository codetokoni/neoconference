import { NextResponse } from 'next/server';

// Handing a sign-in back to the mobile app.
//
// The KingsChat and NeoEmail callbacks finish by minting a short-lived Clerk
// sign-in ticket and redirecting to /sign-in with it. That is right for a
// browser, where /sign-in has a Clerk session to put the ticket into. The
// mobile app has no browser session: it needs the ticket itself, so it can
// redeem it against Clerk's Frontend API and hold the session on the phone.
//
// So the app asks for one specific destination, and the callbacks send the
// ticket there instead. Both start routes otherwise relay only same-origin
// relative paths, and that guard stays exactly as strict as it was — this is
// one literal string, compared whole, never a pattern. An attacker cannot use
// it to reach a destination of their choosing, because there is only one.

export const APP_CALLBACK = 'neoconference://auth';

/** True when the sign-in was started by the mobile app. */
export function isAppCallback(raw: string | null | undefined): boolean {
  return (raw || '').trim() === APP_CALLBACK;
}

/**
 * Relays a value the caller asked to come back to.
 *
 * Accepts a same-origin relative path, or the app's one deep link, and
 * nothing else — an absolute or protocol-relative URL would make the route an
 * open redirect.
 */
export function safeRelay(raw: string | null | undefined): string {
  const value = (raw || '').trim();
  if (isAppCallback(value)) return value;
  return value.startsWith('/') && !value.startsWith('//') ? value : '';
}

/**
 * Sends the browser into the app.
 *
 * Built by hand rather than with NextResponse.redirect, which expects an
 * http(s) URL. A 303 keeps the method a GET, matching the redirects around it.
 */
export function redirectToApp(params: Record<string, string>): NextResponse {
  const url = new URL(APP_CALLBACK);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextResponse(null, {
    status: 303,
    headers: { Location: url.toString() },
  });
}
