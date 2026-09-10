import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import QueueList from "@/components/video/QueueList";
import { roomLink, SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Queues — NeoConference",
  robots: { index: false, follow: false },
};

// Requires a signed-in Clerk account — see the note on
// src/app/video/room/moderate/page.tsx.
export default async function QueuesIndex({
  searchParams,
}: {
  searchParams?: { room?: string };
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <a
          href={`/video/room${roomLink(room)}`}
          className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45 hover:text-white/80"
        >
          ← Hub
        </a>
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Queues</h1>
        <p className="max-w-[64ch] text-sm text-white/60">
          Stage who goes on air next. Each queue is an ordered list — top of the list takes one
          click to feature. Multiple named queues let you plan different segments in parallel.
        </p>
      </header>

      <QueueList room={room} />
    </main>
  );
}
