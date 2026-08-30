// src/app/[slug]/page.tsx
//
// Top-level short URL for a meeting: `neoconference.app/<slug>` → the room.
//
// Next.js App Router prioritises static routes over dynamic segments, so
// every existing top-level route (/dashboard, /pricing, /api/*, /room,
// /e, /i, /share, /admin, /docs, /embed, /explore, /sign-in, /sign-out,
// /sign-up) beats this catch-all. Only unmatched top-level paths hit
// here.
//
// Behaviour:
//   - Slug matches an event → 307 redirect to /room/<livekitRoom>?event=<slug>
//     (307 preserves method + query — GET clients follow, and it never
//     gets cached as permanent so a slug that later becomes reserved by a
//     new top-level route recovers cleanly.)
//   - No match → notFound() → the app's 404 page.
//
// Note on reserved slugs: because static routes win, a slug that
// collides with an existing top-level directory (e.g. "dashboard") is
// unreachable via the short URL. It still works at /e/<slug> and
// /room/<slug>?event=<slug>. If we want to prevent that collision at
// creation time, add a reserved-word list to the slug validators in
// /api/events/create, /api/events/instant, and /api/events/rename.
// Deliberately not doing that here — the short URL is a UX shortcut,
// not the canonical identifier.

import { notFound, redirect } from "next/navigation";
import { eventStore } from "@/lib/eventStore";

export const dynamic = "force-dynamic";

export default async function ShortMeetingUrl({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug: raw } = await params;
  const slug = (raw || "").trim().toLowerCase();
  if (!slug) notFound();

  const event = await eventStore.bySlug(slug);
  if (!event) notFound();

  const target = "/room/" + encodeURIComponent(event.livekitRoom) +
    "?event=" + encodeURIComponent(event.slug);
  redirect(target);
}
