import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';
import {
  SESSION_COOKIE,
  generateDeviceFingerprint,
  getClientIp,
  validateSession,
} from '@/lib/sessionStore';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/room/(.*)',
  '/explore',
  '/pricing',
  '/e/(.*)',
  '/embed/(.*)',
  '/share/(.*)',
  '/replay/(.*)',
  '/api/qr/(.*)',
  '/api/livekit/token(.*)',
  '/api/livekit/webhook(.*)',
  '/api/auth/kingschat/(.*)',
  '/api/auth/neoemail/(.*)',
  '/api/events/by-domain',
  '/api/stripe/webhook',
  '/api/events/(.*)/checkout',
  '/api/invites/(.*)',
  '/api/cron/(.*)',
  '/i/(.*)',
  '/video/dashboard',
  // Listed individually on purpose: a wildcard here would silently expose
  // every future /api/video route, including the staff-only ones.
  '/api/video/status',
  '/api/video/chat',
]);

// Hosts that ARE the canonical app (skip custom-domain rewrite for these).
const CANONICAL_HOST_RE = /^(localhost(:\d+)?|.*\.vercel\.app|neoconference\.vercel\.app)$/i;

// Edge-safe lookup: ask /api/events/by-domain?host=<host>. Cached in process
// memory for 60s to avoid hammering KV on every request.
type CacheEntry = { slug: string | null; expiresAt: number };
const domainCache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

async function resolveDomain(host: string, origin: string): Promise<string | null> {
  const cached = domainCache.get(host);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.slug;
  try {
    const res = await fetch(origin + '/api/events/by-domain?host=' + encodeURIComponent(host), {
      headers: { 'x-internal': 'middleware' },
      next: { revalidate: 60 },
    } as RequestInit);
    if (!res.ok) {
      domainCache.set(host, { slug: null, expiresAt: now + TTL_MS });
      return null;
    }
    const data = (await res.json()) as { slug?: string };
    const slug = data?.slug || null;
    domainCache.set(host, { slug, expiresAt: now + TTL_MS });
    return slug;
  } catch {
    domainCache.set(host, { slug: null, expiresAt: now + TTL_MS });
    return null;
  }
}

/* -----------------------------------------------------------------------
   Short-meeting-URL rewrite

   Turns `neoconference.app/<slug>` into a server-side rewrite of
   `/room/<slug>?event=<slug>`. The browser's address bar stays on the
   short URL — a REDIRECT (like the /[slug]/page.tsx server component
   shipped in PR #117) would bounce and the address bar would jump to
   the long form; REWRITE is invisible to the client.

   Skip conditions:
     - path has more than one segment (e.g. /dashboard/billing)
     - path segment is a reserved top-level route name
     - path is exactly '/' (root landing page)

   No KV lookup here — matches any single-segment slug that passes the
   regex, and lets the room page handle unknown slugs (already does via
   adoptOrphanRoom or 404, depending on auth state). Adding a lookup
   would mean a KV round-trip on every request; not worth it for a UX
   shortcut. The [slug]/page.tsx from PR #117 is kept as a fallback for
   requests that skip middleware.

   RESERVED_SHORT_URL_SLUGS covers every top-level route that exists
   today. If a new one is added, extend this set — otherwise the new
   route will be shadowed by this rewrite.
   ----------------------------------------------------------------------- */

const RESERVED_SHORT_URL_SLUGS = new Set([
  'admin', 'api', 'dashboard', 'docs', 'e', 'embed', 'explore', 'fonts',
  'i', 'pricing', 'room', 'share', 'video',
  'sign-in', 'sign-up', 'sign-out',
  '_next', '_vercel',
]);

// Matches a single URL segment shaped like a valid meeting slug — 1-64
// chars, lowercase alphanumerics and dashes, no leading/trailing dash.
// Mirrors SLUG_REGEX in /api/events/rename so the middleware and the
// slug validators agree on what's shaped like a slug.
const SHORT_URL_SLUG_RE = /^\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/?$/;

function maybeRewriteShortMeetingUrl(req: NextRequest): NextResponse | null {
  const match = req.nextUrl.pathname.match(SHORT_URL_SLUG_RE);
  if (!match) return null;
  const slug = match[1];
  if (RESERVED_SHORT_URL_SLUGS.has(slug)) return null;
  const url = req.nextUrl.clone();
  url.pathname = '/room/' + slug;
  // Only set ?event= when the caller hasn't already — a rewrite target
  // that already carries the parameter shouldn't be overwritten.
  if (!url.searchParams.has('event')) {
    url.searchParams.set('event', slug);
  }
  return NextResponse.rewrite(url);
}

async function maybeRewriteCustomDomain(req: NextRequest): Promise<NextResponse | null> {
  const host = (req.headers.get('host') || '').toLowerCase();
  if (!host || CANONICAL_HOST_RE.test(host)) return null;
  const p = req.nextUrl.pathname;
  if (p.startsWith('/_next') || p.startsWith('/api') || p.startsWith('/sign-in') || p.startsWith('/sign-up') || p.startsWith('/dashboard') || p.startsWith('/pricing')) {
    return null;
  }
  const slug = await resolveDomain(host, req.nextUrl.origin);
  if (!slug) return null;
  let target = '/e/' + slug;
  if (p === '/replay' || p.startsWith('/replay/')) target = '/e/' + slug + '/replay';
  else if (p === '/embed' || p.startsWith('/embed/')) target = '/embed/' + slug;
  else if (p && p !== '/') target = '/e/' + slug + p;
  const url = req.nextUrl.clone();
  url.pathname = target;
  return NextResponse.rewrite(url);
}

// Routes that must never be bounced by the persistent-session check:
// create-session mints the cookie, logout clears it, and /sign-out needs to
// run its cleanup even when the session has already been revoked elsewhere.
const isSessionExemptRoute = createRouteMatcher([
  '/api/auth/create-session',
  '/api/auth/logout',
  '/api/auth/sessions',
  '/sign-out',
]);

/**
 * Validates the persistent device session cookie.
 *
 * Returns a response only when the session is definitively bad (revoked from
 * another device, expired, or presented from a different device) — in that case
 * the user is signed out. A KV outage returns 'error' and we deliberately fall
 * through: Clerk has already authenticated the request, and an infrastructure
 * blip must not sign the whole app out.
 */
async function enforcePersistentSession(req: NextRequest): Promise<NextResponse | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  // No cookie yet — <SessionBootstrap /> will mint one on the next paint.
  if (!token) return null;

  const fingerprint = await generateDeviceFingerprint(
    req.headers.get('user-agent') || '',
    req.headers.get('accept-language') || '',
  );

  const result = await validateSession(token, getClientIp(req.headers), fingerprint);
  if (result.status !== 'invalid') return null;

  if (req.nextUrl.pathname.startsWith('/api/')) {
    const res = NextResponse.json({ error: 'Session revoked' }, { status: 401 });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  const signIn = new URL('/sign-in', req.url);
  signIn.searchParams.set('session_ended', '1');
  const res = NextResponse.redirect(signIn);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}

export default clerkMiddleware(
  async (auth, req) => {
    const nextReq = req as unknown as NextRequest;
    // Custom-domain rewrite runs first because it's tenant-scoped and
    // consumes the whole path. Short-meeting-URL rewrite runs second so
    // it only sees canonical-domain requests.
    const domainRewrite = await maybeRewriteCustomDomain(nextReq);
    if (domainRewrite) return domainRewrite;
    const shortRewrite = maybeRewriteShortMeetingUrl(nextReq);
    if (shortRewrite) return shortRewrite;
    if (!isPublicRoute(req)) {
      await auth.protect();
      if (!isSessionExemptRoute(req)) {
        const revoked = await enforcePersistentSession(req as unknown as NextRequest);
        if (revoked) return revoked;
      }
    }
  },
  {
    authorizedParties: [
      'https://neoconference.vercel.app',
      'https://www.neoconference.app',
      'https://neoconference.app',
      'https://special-space-potato-5v6vj4v99r4h474p-3000.app.github.dev',
      'http://localhost:3000',
    ],
  }
);

export const config = {
  matcher: [
    '/((?!_next|api/auth/kingschat|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api(?!/auth/kingschat)|trpc)(.*)',
  ],
};
