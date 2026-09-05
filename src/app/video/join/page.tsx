import type { Metadata } from "next";
import JoinFlow from "@/components/video/JoinFlow";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Join — NeoConference",
  description: "Enter your participant code to join the event with your camera.",
  robots: { index: false, follow: false },
};

export default function VideoJoinPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
          Participants
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Join the event</h1>
      </header>
      <JoinFlow />
    </main>
  );
}
