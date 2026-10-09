import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import ModeratorDisplay from "@/components/video/ModeratorDisplay";
import { getRoom } from "@/lib/rooms";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Moderator — NeoConference",
  robots: { index: false, follow: false },
};

/**
 * The moderator handout URL: a display. The live broadcast fills the
 * screen; boards, queues, screens and health are one click away in a
 * drawer (src/components/video/ModeratorDisplay.tsx). It omits everything
 * an admin holds close: the copyable Join / Streaming / Moderator links,
 * the code prefix, the roster upload and download.
 *
 * Requires a signed-in Clerk account (any account — no role gate);
 * moderator actions mutate broadcast state, so every hit lands with a
 * name attached. Middleware bounces anonymous traffic to Clerk's
 * sign-in with the correct redirect_url; the auth() check here is
 * belt-and-braces if that ever regresses. The admin surface at
 * /video/room stays gated to the admin email list on top of this.
 */
export default async function ModeratePage({
  searchParams,
}: {
  searchParams?: { room?: string };
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const room = (searchParams?.room ?? SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "");
  const roomRecord = await getRoom(room);
  const roomName = roomRecord?.name ?? room;

  return <ModeratorDisplay room={room} roomName={roomName} />;
}
