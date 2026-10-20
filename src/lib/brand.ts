// src/lib/brand.ts
//
// The product's name and address, in one place. NeoConference became
// NeoLinguaMeet at neolinguameet.com (owner, 2026-10-19). Two switches,
// because the name could change at once but the address waits for Clerk:
//
//   The name (logo, wording, titles, emails, icons): NeoLinguaMeet since
//   2026-10-20 (owner: "rename now"). NEXT_PUBLIC_BRAND_NAME=neoconference
//   puts the old name back.
//
//   The address (links built, redirects from the old domain, canonical
//   host): moves with NEXT_PUBLIC_PRIMARY_DOMAIN=neolinguameet.com, set on
//   switch day together with Clerk's new domain. Until then everything is
//   served and linked on www.neoconference.app (and neolinguameet.com
//   serves the same site).
//
// NEXT_PUBLIC_, so pages in the browser read the same values. They are
// built in at deploy time: change them in Vercel, then redeploy.
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
  /** The line the homepage leads with, and the title carries ("LinguaMeet by Neo"). */
  tagline: string | null;
  /** The site has moved to neolinguameet.com: the old domain's pages redirect there. */
  moved: boolean;
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
  tagline: null,
  moved: false,
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
  // The owner's line for the new name (2026-10-20).
  tagline: "LinguaMeet by Neo",
  moved: true,
};

/**
 * The name from one switch, the address from the other (see the header).
 * Moving the address brings the new name with it whatever the name says.
 */
export function brandFor(primaryDomain: string | undefined, brandName?: string): Brand {
  const d = (primaryDomain || "").trim().toLowerCase().replace(/^www\./, "");
  const moved = d === NEOLINGUAMEET.domain;
  const named = moved || (brandName || "").trim().toLowerCase() !== NEOCONFERENCE.id;
  const names = named ? NEOLINGUAMEET : NEOCONFERENCE;
  const place = moved ? NEOLINGUAMEET : NEOCONFERENCE;
  return {
    id: names.id,
    name: names.name,
    nameHead: names.nameHead,
    nameTail: names.nameTail,
    tagline: names.tagline,
    // info@neolinguameet.com receives mail already (Namecheap forwarding).
    supportEmail: names.supportEmail,
    domain: place.domain,
    host: place.host,
    origin: place.origin,
    moved,
  };
}

export const BRAND: Brand = brandFor(process.env.NEXT_PUBLIC_PRIMARY_DOMAIN, process.env.NEXT_PUBLIC_BRAND_NAME);

/** The site's title: browser tabs, search results and link previews. */
export function siteTitle(brand: Brand = BRAND): string {
  return brand.tagline
    ? `${brand.name} — ${brand.tagline}, video meetings with live translation`
    : `${brand.name} — Video meetings with live translation`;
}

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
  // The address, not the name: renaming alone moves nobody.
  if (!brand.moved) return null;
  const h = (host || url.host).toLowerCase().replace(/:\d+$/, "");
  const isOld = (LEGACY_HOSTS as readonly string[]).includes(h);
  const isNewWww = h === "www." + brand.domain;
  if (!isOld && !isNewWww) return null;
  if (isOld && KEEP_ON_OLD_DOMAIN.test(url.pathname)) return null;
  return new URL(url.pathname + url.search, brand.origin);
}
