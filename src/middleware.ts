import { clerkClient, clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { kv } from '@/lib/kv';
import { markActive } from '@/lib/activity';
import { RESERVED_SHORT_URL_SLUGS } from '@/lib/reservedSlugs';
import { platformGate } from '@/lib/platform/gate';
import {
  SESSION_COOKIE,
  generateDeviceFingerprint,
  getClientIp,
  validateSession,
} from '@/lib/sessionStore';

const isPublicRoute = createRouteMatcher([
  '/',
  // Android fetches /.well-known/assetlinks.json anonymously to verify that
  // this domain vouches for the app. The matcher below does not exclude
  // .json, so without this the verifier is auth-protected, gets a 404, and
  // App Links silently fall back to opening in a browser — with no error
  // anywhere to explain why.
  '/.well-known/(.*)',
  // Where a sign-in started in the app comes back to. Reached before the
  // person has a web session, by definition.
  '/app/auth',
  // Says which commit is serving. A deploy check that needs credentials is
  // a check nobody runs, and protecting this would make a stale alias look
  // like an auth failure instead of what it is.
  '/api/version',
  // The public developer API and its reference. /api/v1 checks its own
  // nc_live_ keys (requireApiKey); a key is not a website session, so
  // behind auth.protect() every call — and the reference itself — got
  // Clerk's 404 from the day the API was added (19 Jul to 8 Oct 2026).
  // Making keys (/dashboard/developers, /api/developers/keys) still needs
  // sign-in.
  '/api/v1/(.*)',
  '/docs',
  '/openapi.json',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/room/(.*)',
  '/explore',
  '/pricing',
  // Help & support: the app's sign-in screen opens it for people who
  // cannot sign in, so it must not ask them to sign in first.
  '/support',
  // Where a new account the registration rules refuse is told why.
  '/access-blocked',
  // The platform logo (admin settings), shown in the header to everyone.
  '/api/platform/logo',
  // The contact form works signed out (bot check and rate limits in the
  // routes); GET of the ticket list checks sign-in itself. A ticket's page
  // and API (/support/tickets/..., /api/support/tickets/<id>) stay behind
  // sign-in. The help centre is public and meant to be indexed.
  '/api/support/session',
  '/api/support/tickets',
  '/help',
  '/help/(.*)',
  '/api/help/suggest',
  '/e/(.*)',
  '/embed/(.*)',
  '/share/(.*)',
  // Report a replay or shared recording, signed in or not. The route
  // rate limits per address and account (src/lib/content/reports.ts).
  '/api/content/reports',
  '/replay/(.*)',
  '/api/qr/(.*)',
  '/api/livekit/token(.*)',
  '/api/livekit/webhook(.*)',
  // Deepgram posts finished transcripts here; the signed job id in the
  // URL is the credential (src/lib/deepgramResult.ts).
  '/api/transcribe/deepgram',
  '/api/auth/kingschat/(.*)',
  '/api/auth/neoemail/(.*)',
  '/api/events/by-domain',
  '/api/stripe/webhook',
  // Where eSPees sends the buyer after a payment, or a cancelled one. A
  // purchase started in the mobile app opens the checkout in the phone's
  // browser, which has no web session, so behind auth.protect() both
  // landed on /sign-in: the plan was never granted and the app never heard
  // back. Each is keyed by the nonce minted at checkout; neither reads the
  // session.
  '/api/billing/espees/return',
  '/api/billing/espees/fail',
  // The plan catalog /pricing reads (src/lib/billing): /pricing is public.
  '/api/billing/plans',
  '/api/events/(.*)/checkout',
  '/api/invites/(.*)',
  // A group invite link opened before signing in: the landing page and its
  // preview. Joining (POST) checks auth() in the route itself.
  '/groups/join/(.*)',
  '/api/groups/invite/(.*)',
  '/api/cron/(.*)',
  // The scheduler's tick. No session: the bearer secret checked in the route
  // (DISPATCH_SECRET / CRON_SECRET) is the credential.
  '/api/internal/dispatch',
  // Unsubscribe links in announcement emails work signed out: the signed
  // token in ?t= is the credential (src/lib/comms/prefs.ts). Resend's
  // delivery reports carry a Svix signature checked in the route.
  '/unsubscribe',
  '/api/comms/unsubscribe',
  '/api/comms/resend-webhook',
  '/i/(.*)',
  '/video/dashboard',
  // Listed individually on purpose: a wildcard here would silently expose
  // every future /api/video route, including the staff-only ones.
  '/api/video/status',
  '/api/video/chat',
  // Programme timer: GET is what audience-facing viewers hit to
  // render the overlay; POST/PATCH/DELETE guard themselves via
  // auth() in the route so they're fine to expose here too.
  '/api/video/room/timer',
  // Participants have no account; the personal code is the credential and
  // the route rate limits hard. /api/video/codes and /feature stay staff-only.
  '/video/join',
  '/api/video/join',
  // Studio (feed pusher) stays deliberately unauthenticated: the room
  // slug in the URL is the shared secret. Guest broadcasters shouldn't
  // need to sign up just to push a feed.
  //
  // The moderator hub (/video/room/moderate) and every board it links
  // to now require a Clerk sign-in — any account works, no role gate,
  // but every moderator action lands with a name attached. This is
  // stricter than earlier revisions of this file: opening the boards
  // to fully-anonymous traffic let anyone who knew a room slug feature
  // participants on air, hide tiles, and stop broadcasts. Any account
  // is still low enough friction that volunteer moderators can sign up
  // in 30s. The admin surface at /video/room (bare) and roster
  // upload/download remain gated to the admin email list
  // (videoAdmin.ts) on top of the sign-in wall.
  '/video/studio',
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

   Turns `neoconference.app/<slug>` into a server-side rewrite that hides
   the underlying `/e/<slug>` (landing card) or `/room/<slug>?event=<slug>`
   (in-room UI) target. Which one it picks depends on the event's current
   state — scheduled events show the landing card so hosts and guests
   see the countdown + "Start now" CTA; live/waiting events go straight
   into the room. Either way the browser's address bar keeps the short
   URL, which is the whole point.

   Two KV round-trips per request (`neo:slug:<slug>` -> id, then
   `neo:event:<id>` -> state). Cached in-memory with a 2 s TTL keyed by
   slug — fresh enough that a host tapping Start now sees the room on
   their next navigation, small enough to absorb bursty RSC prefetches
   without repeatedly hitting Upstash. Cache misses on state-changing
   endpoints (start / end / etc.) resolve within the same window.

   Skip conditions:
     - path has more than one segment (e.g. /dashboard/billing)
     - path segment is a reserved top-level route name
     - path is exactly '/' (root landing page)

   Orphan slugs (no event exists yet) route to /room so the room page's
   adoptOrphanRoom path can create the event with the first authenticated
   caller as owner. This matches how the rewrite worked before this
   state-aware split.

   RESERVED_SHORT_URL_SLUGS covers every top-level route that exists
   today. If a new one is added, extend this set — otherwise the new
   route will be shadowed by this rewrite.
   ----------------------------------------------------------------------- */

// The set lives in lib/reservedSlugs.ts, shared with the Android app gate.

const SHORT_URL_SLUG_RE = /^\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/?$/;

// Tiny in-process cache so RSC prefetches on the same navigation reuse
// one KV lookup. Kept deliberately short (200 ms) so state changes
// (Start now, End meeting) surface on the very next click without
// stranding the operator on the old landing/room for a couple of
// seconds. The cache is only there to absorb the multiple middleware
// hits Next.js makes for a single navigation (prefetch + fetch + RSC
// subroute prefetches), which fire tens of ms apart.
type ShortTargetCacheEntry = { target: string; expiresAt: number };
const shortTargetCache = new Map<string, ShortTargetCacheEntry>();
const SHORT_TARGET_TTL_MS = 200;

async function resolveShortTarget(slug: string): Promise<string> {
  const roomTarget = '/room/' + slug + '?event=' + slug;
  const now = Date.now();
  const hit = shortTargetCache.get(slug);
  if (hit && hit.expiresAt > now) return hit.target;
  let target = roomTarget;
  try {
    const id = await kv.get<string>('neo:slug:' + slug);
    if (id) {
      const ev = await kv.get<{
        state?: string;
        slug?: string;
        livekitRoom?: string;
        isPermanent?: boolean;
      }>('neo:event:' + id);
      if (ev) {
        const canonicalSlug = ev.slug || slug;
        const room = ev.livekitRoom || canonicalSlug;
        // Permanent (personal) rooms bypass the state check — the whole
        // point of the URL is that it's always joinable, no landing card
        // dead-end for ended events. Regular events still route to /e/
        // when scheduled/ended so the countdown / Restart affordance
        // still appears where it makes sense.
        if (ev.isPermanent) {
          target = '/room/' + room + '?event=' + canonicalSlug;
        } else if (ev.state === 'live' || ev.state === 'waiting') {
          target = '/room/' + room + '?event=' + canonicalSlug;
        } else {
          target = '/e/' + canonicalSlug;
        }
      }
    }
  } catch {
    // KV outage — leave target on the /room fallback so the room page's
    // own orphan-adoption / 404 handling takes over instead of surfacing
    // a raw infra error to the browser.
  }
  shortTargetCache.set(slug, { target, expiresAt: now + SHORT_TARGET_TTL_MS });
  return target;
}

async function maybeRewriteShortMeetingUrl(req: NextRequest): Promise<NextResponse | null> {
  const match = req.nextUrl.pathname.match(SHORT_URL_SLUG_RE);
  if (!match) return null;
  const slug = match[1];
  if (RESERVED_SHORT_URL_SLUGS.has(slug)) return null;
  const target = await resolveShortTarget(slug);
  const [targetPath, targetQuery] = target.split('?');
  const url = req.nextUrl.clone();
  url.pathname = targetPath;
  if (targetQuery) {
    for (const [k, v] of new URLSearchParams(targetQuery)) {
      // Existing query params on the incoming request win — a caller
      // that explicitly set ?event= or a UTM tag shouldn't be clobbered.
      if (!url.searchParams.has(k)) url.searchParams.set(k, v);
    }
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

/**
 * Daily-active mark for the admin analytics (src/lib/activity.ts). Runs after
 * the response via waitUntil, so it adds no latency; markActive is memoised
 * per instance (one KV round trip per person per day) and never throws.
 */
async function noteActive(auth: () => Promise<{ userId: string | null }>, event: NextFetchEvent): Promise<void> {
  try {
    const { userId } = await auth();
    if (!userId) return;
    event.waitUntil(markActive(userId, async () => (await (await clerkClient()).users.getUser(userId)).createdAt));
  } catch {
    // Analytics never stands in the way of a request.
  }
}

export default clerkMiddleware(
  async (auth, req, event) => {
    const nextReq = req as unknown as NextRequest;
    // Maintenance mode and the registration rules (admin settings) come
    // before everything else. Who is asking is looked up only when one of
    // them is on (src/lib/platform/gate.ts); the owner, administrators and
    // /admin always get through.
    const gated = await platformGate(nextReq, async () => (await auth()).userId ?? null);
    if (gated) return gated;
    await noteActive(auth, event);
    // Custom-domain rewrite runs first because it's tenant-scoped and
    // consumes the whole path. Short-meeting-URL rewrite runs second so
    // it only sees canonical-domain requests.
    const domainRewrite = await maybeRewriteCustomDomain(nextReq);
    if (domainRewrite) return domainRewrite;
    const shortRewrite = await maybeRewriteShortMeetingUrl(nextReq);
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
