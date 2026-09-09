import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import QueueBoard from "@/components/video/QueueBoard";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

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
  searchParams?: { room?: string; display?: string };
  params: { slug: string };
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");
  const slug = String(params.slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);
  const display = searchParams?.display === "1" || searchParams?.display === "true";

  if (display) {
    return (
      <main className="w-full">
        <QueueBoard room={room} slug={slug} display />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <a
          href={`/video/room/queue?room=${encodeURIComponent(room)}`}
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
