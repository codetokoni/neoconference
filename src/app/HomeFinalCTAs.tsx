"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";

function randomRoomName() {
  const adj = ["nova", "lumen", "orbit", "nimbus", "pulse", "vortex", "atlas", "aurora", "echo", "zenith"];
  const a = adj[Math.floor(Math.random() * adj.length)];
  const n = Math.random().toString(36).slice(2, 6);
  return a + "-" + n;
}

export default function HomeFinalCTAs({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const startNew = () => router.push("/room/" + randomRoomName());

  if (signedIn) {
    return (
      <>
        <button onClick={startNew} className="neo-btn px-7 py-3.5">Start a meeting</button>
        <Link href="/dashboard/new" className="neo-btn-ghost px-7 py-3.5">Create event</Link>
        <Link
          href="#"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById("join-quick")?.focus();
          }}
          className="neo-btn-ghost px-7 py-3.5"
        >
          Join with code
        </Link>
      </>
    );
  }

  return (
    <>
      <Link href="/sign-up" className="neo-btn px-7 py-3.5">Create free account</Link>
      <Link href="/sign-in" className="neo-btn-ghost px-7 py-3.5">Sign in</Link>
    </>
  );
}
