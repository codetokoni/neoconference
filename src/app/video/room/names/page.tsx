import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import NameBoard from "@/components/video/NameBoard";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Name board — NeoConference",
  robots: { index: false, follow: false },
};

// Requires a signed-in Clerk account — see the note on
// src/app/video/room/moderate/page.tsx.
export default async function NamesPage({
  searchParams,
}: {
  searchParams?: { room?: string; screen?: string; display?: string };
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");
  const rawScreen = Number(searchParams?.screen ?? "");
  const screen =
    Number.isFinite(rawScreen) && rawScreen >= 1 && rawScreen <= 20
      ? Math.floor(rawScreen)
      : undefined;
  const display = searchParams?.display === "1" || searchParams?.display === "true";

  if (display) {
    return (
      <main className="w-full">
        <NameBoard room={room} screen={screen} display />
      </main>
    );
  }

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
          {screen ? `Screen ${screen} · Name board` : "Name board"}
        </h1>
        <p className="max-w-[64ch] text-sm text-white/60">
          Every participant in one list — no video, zero viewer slots. Click
          any row to open that child fullscreen, feature to air, or send to
          preview. Auto-refreshes every few seconds.{" "}
          <a
            href={`/video/room/names?room=${encodeURIComponent(room)}${screen ? `&screen=${screen}` : ""}&display=1`}
            className="text-emerald-300 hover:text-emerald-200"
          >
            Present on screen →
          </a>
        </p>
      </header>

      <NameBoard room={room} screen={screen} />
    </main>
  );
}
