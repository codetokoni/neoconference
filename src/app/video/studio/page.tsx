import type { Metadata } from "next";
import { redirect } from "next/navigation";
import StudioConsole from "@/components/video/StudioConsole";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Studio — NeoConference",
  robots: { index: false, follow: false },
};

export default async function VideoStudioPage({
  searchParams,
}: {
  searchParams?: { room?: string };
}) {
  const actor = await requireRole(["admin", "staff"]);
  if (!actor) redirect("/dashboard");

  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
          Studio · {room}
        </span>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Push the feed</h1>
        <p className="max-w-[64ch] text-sm text-neutral-600 dark:text-neutral-400">
          Publish the programme from a camera or a shared screen, or run an interpreter booth from
          this machine. Everything lands on the same track group the watch page is already playing.
        </p>
      </header>

      <StudioConsole room={room} />
    </main>
  );
}
