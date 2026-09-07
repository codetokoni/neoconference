import type { Metadata } from "next";
import SimulcastPlayer from "@/components/video/SimulcastPlayer";
import { getRoom } from "@/lib/rooms";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live — NeoConference",
  description: "Watch the live programme feed and choose your listening language.",
  openGraph: {
    title: "Live — NeoConference",
    description: "Watch the live programme feed and choose your listening language.",
    url: "https://neoconference.app/video/dashboard",
  },
};

export default async function VideoDashboardPage({
  searchParams,
}: {
  searchParams?: { room?: string };
}) {
  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");
  const record = await getRoom(room);
  const title = record?.name ?? "NeoConference";

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
          Live now
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">{title}</h1>
        <p className="max-w-[62ch] text-white/60">
          Pick your language under the player. The picture keeps running when you switch.
        </p>
      </header>

      <SimulcastPlayer room={room} />
    </main>
  );
}
