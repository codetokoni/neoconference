import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/room/(.*)',
  '/explore',
  '/e/(.*)',
  '/embed/(.*)',
  '/share/(.*)',
  '/replay/(.*)',
  '/api/qr/(.*)',
  '/api/livekit/token(.*)',
  '/api/auth/kingschat/(.*)',
  '/api/events/by-domain',
  '/api/stripe/webhook',
  '/api/events/(.*)/checkout',
  '/api/invites/(.*)',
  '/i/(.*)',
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

async function maybeRewriteCustomDomain(req: NextRequest): Promise<NextResponse | null> {
  const host = (req.headers.get('host') || '').toLowerCase();
  if (!host || CANONICAL_HOST_RE.test(host)) return null;
  const p = req.nextUrl.pathname;
  if (p.startsWith('/_next') || p.startsWith('/api') || p.startsWith('/sign-in') || p.startsWith('/sign-up') || p.startsWith('/dashboard')) {
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

export default clerkMiddleware(
  async (auth, req) => {
    const rewrite = await maybeRewriteCustomDomain(req as unknown as NextRequest);
    if (rewrite) return rewrite;
    if (!isPublicRoute(req)) {
      await auth.protect();
    }
  },
  {
    authorizedParties: [
      'https://neoconference.vercel.app',
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

