import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/room/(.*)',
  '/api/livekit/token(.*)',
  '/api/auth/kingschat/(.*)',
]);

export default clerkMiddleware(
  async (auth, req) => {
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
    // Skip Next internals and static files
    '/((?!_next|api/auth/kingschat|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Run on tRPC and other API routes, but explicitly skip kingschat callbacks
    '/(api(?!/auth/kingschat)|trpc)(.*)',
  ],
};
