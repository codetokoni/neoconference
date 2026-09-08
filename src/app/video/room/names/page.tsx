import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import NameBoard from "@/components/video/NameBoard";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Name board — NeoConference",
  robots: { index: false, follow: false },
};

// Requires a signed-in Clerk account — see the note on
// src/app/video/room/moderate/page.tsx.
export default async function NamesPage({
  searchParams,
}: {
  searchParams?: { room?: string };
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <a
          href={`/video/room?room=${encodeURIComponent(room)}`}
          className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45 hover:text-white/80"
        >
          ← Hub
        </a>
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Name board
        </h1>
        <p className="max-w-[64ch] text-sm text-white/60">
          Every participant across every screen in one list. The board itself
          renders no video — leave it open all day and it costs zero viewer
          slots. Click any row to open that child fullscreen, feature to air,
          or send to preview. Auto-refreshes every few seconds.
        </p>
      </header>

      <NameBoard room={room} />
    </main>
  );
}
