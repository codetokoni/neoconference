import type { Metadata } from "next";
import { redirect } from "next/navigation";
import QueueList from "@/components/video/QueueList";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Queues — NeoConference",
  robots: { index: false, follow: false },
};

export default async function QueuesIndex({
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
        <a
          href={`/video/room?room=${encodeURIComponent(room)}`}
          className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45 hover:text-white/80"
        >
          ← Hub
        </a>
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Queues</h1>
        <p className="max-w-[64ch] text-sm text-white/60">
          Stage who goes on air next. Each queue is an ordered list — top of the list takes one
          click to feature. Multiple named queues let you plan different segments in parallel.
        </p>
      </header>

      <QueueList room={room} />
    </main>
  );
}
