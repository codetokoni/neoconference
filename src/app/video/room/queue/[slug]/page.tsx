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

// Requires a signed-in Clerk account — see the note on
// src/app/video/room/moderate/page.tsx.
export default async function QueueDetail({
  searchParams,
  params,
}: {
  searchParams?: { room?: string };
  params: { slug: string };
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");
  const slug = String(params.slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6">
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
