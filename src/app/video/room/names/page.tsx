import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import NameBoard from "@/components/video/NameBoard";
import { roomLink, SIMULCAST_MAIN } from "@/lib/simulcast";

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
  searchParams?: {
    room?: string;
    screen?: string;
    display?: string;
    codes?: string;
  };
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
  // `?codes=1` is an explicit opt-in for showing passcodes in
  // display mode — for a moderator running the projected view on
  // their own laptop, not on a physical screen the audience can
  // see. Default stays projector-safe (codes hidden) so a URL like
  // `?display=1` is always safe to cast without leaking join
  // credentials to anyone with a camera in the room.
  const showCodes = searchParams?.codes === "1" || searchParams?.codes === "true";

  if (display) {
    return (
      <main className="w-full">
        <NameBoard room={room} screen={screen} display showCodes={showCodes} />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <a
          href={`/video/room${roomLink(room)}`}
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
            href={`/video/room/names${roomLink(room, { screen, display: 1 })}`}
            className="text-emerald-300 hover:text-emerald-200"
          >
            Present on screen →
          </a>
          {" · "}
          <a
            href={`/video/room/names${roomLink(room, { screen, display: 1, codes: 1 })}`}
            className="text-amber-300 hover:text-amber-200"
            title="Includes join codes — for a moderator's own screen, never a public projector."
          >
            Moderator display (with codes) →
          </a>
        </p>
      </header>

      <NameBoard room={room} screen={screen} />
    </main>
  );
}
