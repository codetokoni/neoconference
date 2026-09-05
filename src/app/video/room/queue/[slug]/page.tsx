import type { Metadata } from "next";
import { redirect } from "next/navigation";
import QueueBoard from "@/components/video/QueueBoard";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Queue — NeoConference",
  robots: { index: false, follow: false },
};

export default async function QueueDetail({
  searchParams,
  params,
}: {
  searchParams?: { room?: string };
  params: { slug: string };
}) {
  // Clerk already protects this path via middleware; this is the role gate.
  const actor = await requireRole(["admin", "staff"]);
  if (!actor) redirect("/dashboard");

  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");
  const slug = String(params.slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <a
          href={`/video/room/queue?room=${encodeURIComponent(room)}`}
          className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45 hover:text-white/80"
        >
          ← Queues
        </a>
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Queue</h1>
      </header>

      <QueueBoard room={room} slug={slug} />
    </main>
  );
}
