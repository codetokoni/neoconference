"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

function randomRoomName() {
  const adj = ["nova", "lumen", "orbit", "nimbus", "pulse", "vortex", "atlas", "aurora", "echo", "zenith"];
  const a = adj[Math.floor(Math.random() * adj.length)];
  const n = Math.random().toString(36).slice(2, 6);
  return a + "-" + n;
}

export default function HomeHeroCTAs({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [join, setJoin] = useState("");

  const startNew = () => router.push("/room/" + randomRoomName());
  const joinNamed = () => {
    const v = join.trim();
    if (!v) return;
    router.push("/room/" + encodeURIComponent(v));
  };

  if (signedIn) {
    return (
      <>
        <button onClick={startNew} className="neo-btn text-base px-6 py-3.5">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h7A2.5 2.5 0 0 1 15 7.5v9A2.5 2.5 0 0 1 12.5 19h-7A2.5 2.5 0 0 1 3 16.5v-9Zm14 1.2 3.3-2a1 1 0 0 1 1.5.86v8.88a1 1 0 0 1-1.5.86L17 15.3V8.7Z"/></svg>
          Start a meeting
        </button>
        <Link href="/dashboard/new" className="neo-btn-ghost text-base px-6 py-3.5 inline-flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>
          Create event
        </Link>
        <Link href="/dashboard" className="neo-btn-ghost text-base px-6 py-3.5 inline-flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
          View past replays
        </Link>
        <div className="flex w-full sm:w-auto items-stretch gap-2">
          <input
            value={join}
            onChange={(e) => setJoin(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") joinNamed(); }}
            placeholder="Enter room code"
            className="neo-input min-w-0 sm:w-64"
            aria-label="Room code"
          />
          <button onClick={joinNamed} disabled={!join.trim()} className="neo-btn-ghost px-5 disabled:opacity-50">
            Join
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <Link href="/sign-up" className="neo-btn text-base px-6 py-3.5">Get started — it&apos;s free</Link>
      <Link href="/sign-in" className="neo-btn-ghost text-base px-6 py-3.5">Sign in</Link>
    </>
  );
}
