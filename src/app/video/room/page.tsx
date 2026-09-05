import type { Metadata } from "next";
import { redirect } from "next/navigation";
import ControlRoom from "@/components/video/ControlRoom";
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
  searchParams?: { screen?: string; room?: string };
}) {
  // Clerk already protects this path via middleware; this is the role gate.
  const actor = await requireRole(["admin", "staff"]);
  if (!actor) redirect("/dashboard");

  const screen = Math.max(1, Math.min(20, Number(searchParams?.screen ?? 1) || 1));
  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
          Control room · {room}
        </span>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Camera board</h1>
        <p className="max-w-[64ch] text-sm text-neutral-600 dark:text-neutral-400">
          Drag to rearrange, × to hide, click a tile to open it. Featuring puts that camera
          full-frame for the public audience until you send it back to the programme.
        </p>
      </header>

      <ControlRoom room={room} screen={screen} />
    </main>
  );
}
