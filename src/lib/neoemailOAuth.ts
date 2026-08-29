// Shared pieces of the "Continue with Neoemail" flow.
//
// In a lib rather than exported from the route: a Next route file may only
// export handlers and route config, and exporting anything else from one is a
// build error rather than a lint warning.

/** Carries the state and the caller's original destination across the round trip. */
export const NEOEMAIL_STATE_COOKIE = 'neoemail_oauth_state';

/** Long enough for a person to read a consent screen, short because the rest is a redirect. */
export const NEOEMAIL_STATE_TTL_SECONDS = 600;

export function neoemailIssuer(): string {
  return (process.env.NEOEMAIL_ISSUER || 'https://neoemail.org').replace(/\/+$/, '');
}

export function neoemailCallbackUri(origin: string): string {
  return process.env.NEOEMAIL_REDIRECT_URI?.trim() || `${origin}/api/auth/neoemail/callback`;
}

/**
 * Splits the cookie into the state and the relayed destination.
 *
 * The destination is stored beside the state rather than on the authorize URL,
 * because Neomail matches the redirect_uri exactly — an extra query parameter
 * there would make it a different URI and the request would be refused.
 */
export function readStateCookie(value: string | undefined): { state: string; redirectUrl: string } {
  if (!value) return { state: '', redirectUrl: '' };
  const decoded = decodeURIComponent(value);
  const separator = decoded.indexOf(':');
  return separator === -1
    ? { state: decoded, redirectUrl: '' }
    : { state: decoded.slice(0, separator), redirectUrl: decoded.slice(separator + 1) };
}
