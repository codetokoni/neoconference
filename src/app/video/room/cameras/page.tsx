import type { Metadata } from "next";
import ControlRoom from "@/components/video/ControlRoom";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Camera board — NeoConference",
  robots: { index: false, follow: false },
};

// Deliberately unauthenticated: the moderator handout URL links here,
// and the moderator hub is public. See the note on
// src/app/video/room/moderate/page.tsx — the room slug is the shared
// secret, admin surfaces at /video/room stay gated.
export default async function CamerasPage({
  searchParams,
}: {
  searchParams?: { room?: string };
}) {
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
          Camera board
        </h1>
        <p className="max-w-[64ch] text-sm text-white/60">
          Every participant across every screen in one grid. Drag to rearrange,
          × to hide, click a tile to open it. Featuring puts that camera
          full-frame for the public audience until you send it back to the programme.
        </p>
      </header>

      <ControlRoom room={room} />
    </main>
  );
}
