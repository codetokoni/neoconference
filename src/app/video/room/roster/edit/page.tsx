import type { Metadata } from "next";
import { redirect } from "next/navigation";
import RosterEditor from "@/components/video/RosterEditor";
import { requireRole } from "@/lib/roles";
import { getRoom } from "@/lib/rooms";
import { roomLink, SIMULCAST_MAIN } from "@/lib/simulcast";
import { isVideoRoomAdmin } from "@/lib/videoAdmin";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Edit roster — NeoConference",
  robots: { index: false, follow: false },
};

/**
 * Admin-only roster editor. This is where you fix an xlsx typo — a
 * wrong name, a missing condition — without re-uploading the whole
 * file. Codes and streamIds are read-only; only labels and roster meta
 * columns are editable.
 */
export default async function RosterEditPage({
  searchParams,
}: {
  searchParams?: { room?: string };
}) {
  const actor = await requireRole(["admin", "staff"]);
  if (!actor) redirect("/dashboard");
  if (!(await isVideoRoomAdmin())) redirect("/dashboard");

  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");
  const roomRecord = await getRoom(room);
  const roomName = roomRecord?.name ?? room;

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <a
          href={`/video/room${roomLink(room)}`}
          className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45 hover:text-white/80"
        >
          ← Hub
        </a>
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
          Edit roster · {roomName}
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Fix roster entries
        </h1>
        <p className="max-w-[64ch] text-sm text-white/60">
          Correct names, conditions, countries and contacts one row at a time.
          Codes and stream ids are permanent — a code you have already sent to
          a participant must not silently change on them.
        </p>
      </header>

      <RosterEditor room={room} />
    </main>
  );
}
