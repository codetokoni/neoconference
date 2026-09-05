import type { Metadata } from "next";
import { redirect } from "next/navigation";
import NameBoard from "@/components/video/NameBoard";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Name board — NeoConference",
  robots: { index: false, follow: false },
};

export default async function NamesPage({
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
          Attendance only. Renders no video, so it costs zero viewer slots on the
          ingest server — leave it open all day. Auto-refreshes every few seconds.
        </p>
      </header>

      <NameBoard room={room} screen={screen} />
    </main>
  );
}
