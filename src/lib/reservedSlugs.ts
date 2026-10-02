// src/lib/reservedSlugs.ts
//
// Every top-level route the site has. A single path segment that is not
// one of these is a meeting's short link (neoconference.app/<slug>): the
// middleware rewrites it to the meeting, and the Android app gate offers to
// open that meeting in the app. Add a new top-level route here, or the
// short-link rewrite will shadow it.
export const RESERVED_SHORT_URL_SLUGS = new Set([
  'admin', 'api', 'app', 'dashboard', 'docs', 'e', 'embed', 'explore', 'fonts',
  'i', 'pricing', 'room', 'share', 'support', 'video',
  'sign-in', 'sign-up', 'sign-out',
  '_next', '_vercel',
]);
