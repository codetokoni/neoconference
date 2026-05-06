"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";

function randomRoomName() {
  return "room-" + Math.random().toString(36).slice(2, 8);
}

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState("");

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="text-4xl font-bold mb-2">NeoConference</h1>
      <p className="text-gray-600 mb-8">
        The next generation of virtual classrooms.
      </p>

      <SignedOut>
        <p className="mb-4">Sign in to create or join a room.</p>
        <SignInButton mode="modal">
          <button className="px-4 py-2 rounded bg-black text-white">
            Sign in
          </button>
        </SignInButton>
      </SignedOut>

      <SignedIn>
        <div className="flex flex-col gap-4 max-w-md">
          <button
            onClick={() => router.push(`/room/${randomRoomName()}`)}
            className="px-4 py-2 rounded bg-black text-white"
          >
            New room
          </button>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="room-name"
              className="flex-1 border rounded px-3 py-2"
            />
            <button
              disabled={!name.trim()}
              onClick={() =>
                router.push(`/room/${encodeURIComponent(name.trim())}`)
              }
              className="px-4 py-2 rounded border disabled:opacity-50"
            >
              Join
            </button>
          </div>
        </div>
      </SignedIn>
    </div>
  );
}
