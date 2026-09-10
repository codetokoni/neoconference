import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import QueueBoard from "@/components/video/QueueBoard";
import { roomLink, SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Queue — NeoConference",
  robots: { index: false, follow: false },
};

/**
 * Short-URL entry point for a named queue.
 *
 *   /video/room/<queue-slug>?room=<room>
 *
 * Handed out from the moderator hub so a producer can go one click
 * from "there are 100 people online out of 1000" to "add these 100 to
 * a queue, click to feature one at a time on air." Renders the same
 * QueueBoard as the older /video/room/queue/<slug> path (kept as a
 * fallback for old links).
 *
 * The static routes moderate / cameras / names / queue / roster take
 * precedence over this dynamic segment, so those pages open normally.
 * The queues API refuses those slugs at create time (see
 * RESERVED_QUEUE_SLUGS) so no queue can ever shadow a page here.
 */
export default async function RoomQueueShortUrl({
  searchParams,
  params,
}: {
  searchParams?: { room?: string; display?: string; screen?: string };
  params: { slug: string };
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");
  const slug = String(params.slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);
  // Display mode has two accepted URL shapes:
  //   ?display=1                          → screen 1 (default page)
  //   ?display=2                          → screen 2 (short form)
  //   ?display=1&screen=2                 → screen 2 (long form, kept
  //                                         so old bookmarks still work)
  //   ?display=true                       → screen 1 (implicit)
  // An explicit `screen` param wins over the number inside `display`
  // when both are set — so a URL like `?display=2&screen=3` renders
  // page 3, matching how humans read \"screen 3\".
  const displayRaw = String(searchParams?.display ?? "").trim();
  const displayAsNum = Number(displayRaw);
  const displayScreen =
    Number.isFinite(displayAsNum) && displayAsNum >= 1 && displayAsNum <= 20
      ? Math.floor(displayAsNum)
      : undefined;
  const display =
    displayScreen !== undefined ||
    displayRaw === "true" ||
    displayRaw === "1";
  const rawScreen = Number(searchParams?.screen ?? "");
  const explicitScreen =
    Number.isFinite(rawScreen) && rawScreen >= 1 && rawScreen <= 20
      ? Math.floor(rawScreen)
      : undefined;
  const screen = explicitScreen ?? displayScreen;

  if (display) {
    // Display mode is capped at 50 entries per screen (PAGE_SIZE in
    // QueueBoard), so fit-to-viewport IS the right model — unlike the
    // roster boards (see [[projector-boards-scale-to-thousands]]) which
    // must scroll because they're uncapped. 65px matches the site-nav
    // height in src/app/layout.tsx.
    return (
      <main className="flex h-[calc(100dvh-65px)] w-full flex-col overflow-hidden">
        <QueueBoard room={room} slug={slug} screen={screen} display />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <a
          href={`/video/room/queue${roomLink(room)}`}
          className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45 hover:text-white/80"
        >
          ← Queues
        </a>
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Queue</h1>
      </header>

      <QueueBoard room={room} slug={slug} />
    </main>
  );
}
