// src/lib/brand.ts
//
// The product's name and address, in one place. NeoConference becomes
// NeoLinguaMeet at neolinguameet.com (owner, 2026-10-19); one setting
// switches the whole site:
//
//   NEXT_PUBLIC_PRIMARY_DOMAIN=neolinguameet.com   → NeoLinguaMeet
//   unset (or neoconference.app)                   → NeoConference, as before
//
// NEXT_PUBLIC_, so pages in the browser read the same value. It is built
// in at deploy time: change it in Vercel, then redeploy.
//
// What must NOT follow the brand:
//   - kc-<id>@kc.neoconference.app, a KingsChat account's identity in Clerk
//     (src/lib/kc-signin.ts). Changing it would make new, empty accounts.
//   - The host in Android intent links (APP_INTENT_HOST): apps up to 1.2.5
//     only claim www.neoconference.app; later ones claim both.
//   - The old domain keeps serving /api, /.well-known and /app (see
//     legacyRedirect): installed apps, App Link checks and webhooks use them.

export type Brand = {
  id: "neoconference" | "neolinguameet";
  /** "NeoLinguaMeet" */
  name: string;
  /** The wordmark in two parts: "Neo" + "LinguaMeet", the second in the gradient. */
  nameHead: string;
  nameTail: string;
  /** "neolinguameet.com": what people type, and say. */
  domain: string;
  /** The canonical host pages are served from. */
  host: string;
  /** "https://neolinguameet.com", no trailing slash. */
  origin: string;
  supportEmail: string;
};

const NEOCONFERENCE: Brand = {
  id: "neoconference",
  name: "NeoConference",
  nameHead: "Neo",
  nameTail: "Conference",
  domain: "neoconference.app",
  host: "www.neoconference.app",
  origin: "https://www.neoconference.app",
  supportEmail: "info@neoconference.app",
};

const NEOLINGUAMEET: Brand = {
  id: "neolinguameet",
  name: "NeoLinguaMeet",
  nameHead: "Neo",
  nameTail: "LinguaMeet",
  domain: "neolinguameet.com",
  // The bare domain is the canonical one; www redirects to it.
  host: "neolinguameet.com",
  origin: "https://neolinguameet.com",
  supportEmail: "info@neolinguameet.com",
};

export function brandFor(primaryDomain: string | undefined): Brand {
  const d = (primaryDomain || "").trim().toLowerCase().replace(/^www\./, "");
  return d === NEOLINGUAMEET.domain ? NEOLINGUAMEET : NEOCONFERENCE;
}

export const BRAND: Brand = brandFor(process.env.NEXT_PUBLIC_PRIMARY_DOMAIN);

/** Every name the product has had, for values saved under an older one. */
export const PAST_NAMES = [NEOCONFERENCE.name] as const;

/** The old site's hosts. */
export const LEGACY_HOSTS = ["neoconference.app", "www.neoconference.app"] as const;
/** The new site's hosts. */
export const NEW_HOSTS = ["neolinguameet.com", "www.neolinguameet.com"] as const;

/** Apps up to 1.2.5 only open links for this host (see the header). */
export const APP_INTENT_HOST = "www.neoconference.app";

/** One of this product's own hosts, old or new. */
export function isOwnHost(host: string | null | undefined): boolean {
  const h = (host || "").toLowerCase().replace(/:\d+$/, "");
  return (LEGACY_HOSTS as readonly string[]).includes(h) || (NEW_HOSTS as readonly string[]).includes(h);
}

/**
 * The address links are built from (emails, invitations, QR codes,
 * recordings). NEXT_PUBLIC_SITE_URL / NEXT_PUBLIC_APP_URL still win, then
 * the request's own host - so a preview or local build links to itself -
 * but either production domain, old or new, always becomes the current
 * brand's: after the switch no new link points at the old domain, whatever
 * those settings still say and whichever domain the request came in on.
 */
export function linkOrigin(req?: Request): string {
  const env = (process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  if (env) {
    try {
      return isOwnHost(new URL(env).host) ? BRAND.origin : env;
    } catch {
      return BRAND.origin;
    }
  }
  const host = req?.headers.get("host");
  if (req && host && !isOwnHost(host)) return (req.headers.get("x-forwarded-proto") ?? "https") + "://" + host;
  return BRAND.origin;
}

/** linkOrigin() where there is no request (crons, background sends). */
export function siteOrigin(): string {
  return linkOrigin();
}

/** A saved name that was only ever the default: the current brand's instead. */
export function currentName(saved: string | null | undefined): string {
  const s = (saved || "").trim();
  return !s || (PAST_NAMES as readonly string[]).includes(s) ? BRAND.name : s;
}

/** Paths the old domain keeps serving itself, never redirected. */
const KEEP_ON_OLD_DOMAIN = /^\/(api|\.well-known|app)(\/|$)/;

/**
 * Where a request to one of our hosts should go instead, or null to serve
 * it. Only once the brand is NeoLinguaMeet:
 *   www.neolinguameet.com/x?y      → https://neolinguameet.com/x?y
 *   (www.)neoconference.app/x?y    → https://neolinguameet.com/x?y
 * except /api, /.well-known and /app on the old domain (see the header).
 * One hop, path and query kept; the fragment never reaches the server and
 * the browser carries it across the redirect itself.
 */
export function legacyRedirect(url: URL, host: string | null, brand: Brand = BRAND): URL | null {
  if (brand.id !== "neolinguameet") return null;
  const h = (host || url.host).toLowerCase().replace(/:\d+$/, "");
  const isOld = (LEGACY_HOSTS as readonly string[]).includes(h);
  const isNewWww = h === "www." + brand.domain;
  if (!isOld && !isNewWww) return null;
  if (isOld && KEEP_ON_OLD_DOMAIN.test(url.pathname)) return null;
  return new URL(url.pathname + url.search, brand.origin);
}
