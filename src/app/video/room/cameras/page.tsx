import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import ControlRoom from "@/components/video/ControlRoom";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Camera board — NeoConference",
  robots: { index: false, follow: false },
};

// Requires a signed-in Clerk account — see the note on
// src/app/video/room/moderate/page.tsx.
export default async function CamerasPage({
  searchParams,
}: {
  searchParams?: { room?: string; screen?: string; display?: string };
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");
  // Optional screen filter. With ?screen=N the board renders just
  // that screen's block (Screen 1 = slots 1-50, Screen 2 = 51-100,
  // …); without it, the historical unified view is unchanged.
  const rawScreen = Number(searchParams?.screen ?? "");
  const screen =
    Number.isFinite(rawScreen) && rawScreen >= 1 && rawScreen <= 20
      ? Math.floor(rawScreen)
      : undefined;
  // ?display=1 strips the producer chrome — page header, on-air
  // strip, preview pane, hidden pills, drag/hide/click affordances
  // — leaving just the tile grid so a moderator can put the board
  // on a projector for the room to see.
  const display = searchParams?.display === "1" || searchParams?.display === "true";

  if (display) {
    // Display mode targets projectors AND huge rosters. Tiles keep a
    // comfortable 4:3 aspect so a moderator can read names on a
    // 2000-slot event; the page scrolls when the roster exceeds the
    // viewport. `min-h-[calc(100dvh-65px)]` keeps the background dark
    // even when the roster is small enough to leave space below the
    // last row. 65px matches the site-nav height in src/app/layout.tsx.
    return (
      <main className="w-full min-h-[calc(100dvh-65px)]">
        <ControlRoom room={room} screen={screen} display />
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
          {screen ? `Screen ${screen} · Camera board` : "Camera board"}
        </h1>
        <p className="max-w-[64ch] text-sm text-white/60">
          {screen ? (
            <>
              Only Screen {screen}&apos;s block of participants. Drag to
              rearrange, × to hide, click a tile to open it. Featuring puts
              that camera full-frame for the public audience until you send it
              back to the programme.{" "}
              <a
                href={`/video/room/cameras?room=${encodeURIComponent(room)}`}
                className="text-emerald-300 hover:text-emerald-200"
              >
                See all screens →
              </a>
              {" · "}
              <a
                href={`/video/room/cameras?room=${encodeURIComponent(room)}&screen=${screen}&display=1`}
                className="text-emerald-300 hover:text-emerald-200"
              >
                Present on screen →
              </a>
            </>
          ) : (
            <>
              Every participant across every screen in one grid. Drag to
              rearrange, × to hide, click a tile to open it. Featuring puts
              that camera full-frame for the public audience until you send it
              back to the programme.
            </>
          )}
        </p>
      </header>

      <ControlRoom room={room} screen={screen} />
    </main>
  );
}
