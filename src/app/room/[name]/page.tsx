"use client";

import { useEffect, useState } from "react";
import { useUser, RedirectToSignIn } from "@clerk/nextjs";
import {
  LiveKitRoom,
  VideoConference,
  RoomAudioRenderer,
  ControlBar,
} from "@livekit/components-react";
import "@livekit/components-styles";

export default function RoomPage({ params }: { params: { name: string } }) {
  const { isLoaded, isSignedIn } = useUser();
  const [token, setToken] = useState<string | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const roomName = decodeURIComponent(params.name);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    (async () => {
      try {
        const res = await fetch(
          `/api/livekit/token?room=${encodeURIComponent(roomName)}`,
          { cache: "no-store" }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { token: string; wsUrl: string };
        setToken(data.token);
        setWsUrl(data.wsUrl);
      } catch (e: any) {
        setError(e?.message || "Failed to fetch token");
      }
    })();
  }, [isLoaded, isSignedIn, roomName]);

  if (!isLoaded) return <div className="p-8">Loading…</div>;

  if (!isSignedIn) {
    return (
      <RedirectToSignIn
        redirectUrl={typeof window !== "undefined" ? window.location.pathname : "/"}
      />
    );
  }

  if (error)
    return (
      <div className="p-8 max-w-md mx-auto text-center">
        <h1 className="text-xl font-semibold mb-2">Could not join room</h1>
        <p className="text-sm text-gray-600 mb-4">
          We couldn't get a connection token for <strong>{roomName}</strong>.
        </p>
        <p className="text-xs text-red-600 break-all">{error}</p>
        <a href="/" className="inline-block mt-6 underline text-sm">
          ← Back to home
        </a>
      </div>
    );

  if (!token || !wsUrl) return <div className="p-8">Connecting…</div>;

  return (
    <div data-lk-theme="default" style={{ height: "calc(100vh - 65px)" }}>
      <LiveKitRoom
        serverUrl={wsUrl}
        token={token}
        connect={true}
        audio={true}
        video={true}
      >
        <VideoConference />
        <RoomAudioRenderer />
        <ControlBar />
      </LiveKitRoom>
    </div>
  );
}
