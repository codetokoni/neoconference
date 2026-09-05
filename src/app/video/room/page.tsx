import type { Metadata } from "next";
import { redirect } from "next/navigation";
import RoomHub from "@/components/video/RoomHub";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Control room — NeoConference",
  robots: { index: false, follow: false },
};

export default async function VideoRoomPage({
  searchParams,
}: {
  searchParams?: { room?: string };
}) {
  // Clerk already protects this path via middleware; this is the role gate.
  const actor = await requireRole(["admin", "staff"]);
  if (!actor) redirect("/dashboard");

  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
          Control room · {room}
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Hub</h1>
        <p className="max-w-[64ch] text-sm text-white/60">
          On air, who is here, and every board you can open on this event. Boards deep-link
          with ?screen= so you can open one on a second monitor without losing the others.
        </p>
      </header>

      <RoomHub room={room} />
    </main>
  );
}
