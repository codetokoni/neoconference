import type { Metadata } from "next";
import { redirect } from "next/navigation";
import RoomsList from "@/components/video/RoomsList";
import { requireRole } from "@/lib/roles";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Rooms — NeoConference",
  robots: { index: false, follow: false },
};

export default async function RoomsPage() {
  // Clerk already protects this path via middleware; this is the role gate.
  const actor = await requireRole(["admin", "staff"]);
  if (!actor) redirect("/dashboard");

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Rooms</h1>
        <p className="max-w-[64ch] text-sm text-white/60">
          One room per event. Creating a room mints its personal codes and gives you a hub,
          camera board, name board and queue — everything scoped to that slug.
        </p>
      </header>

      <RoomsList />
    </main>
  );
}
