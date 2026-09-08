import type { Metadata } from "next";
import RoomHub from "@/components/video/RoomHub";
import { getRoom } from "@/lib/rooms";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Moderator — NeoConference",
  robots: { index: false, follow: false },
};

/**
 * The moderator handout URL.
 *
 * This is the link admins hand to whoever is running the boards during
 * the event. It renders the same live counts, boards, and per-screen
 * cards as the admin hub, but omits everything an admin holds close:
 * the copyable Join / Streaming / Moderator links, the code prefix, the
 * roster upload and download.
 *
 * Deliberately unauthenticated: the room slug in the query string is
 * the shared secret; requiring Clerk for moderator handouts blocked
 * guest volunteers who help run boards during events. The admin
 * surface at /video/room stays gated to the admin email list — this
 * page never exposes the admin-only affordances regardless of who
 * opens it.
 */
export default async function ModeratePage({
  searchParams,
}: {
  searchParams?: { room?: string };
}) {
  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");
  const roomRecord = await getRoom(room);
  const roomName = roomRecord?.name ?? room;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
          Moderator · {roomName}
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Control room
        </h1>
        <p className="max-w-[64ch] text-sm text-white/60">
          Live state and boards for this event. Open Camera board on the projector,
          Name board on a side monitor, Queue on your workstation. Boards deep-link
          with ?screen= so opening one on a second display doesn't lose the others.
        </p>
      </header>

      <RoomHub room={room} role="moderator" />
    </main>
  );
}
