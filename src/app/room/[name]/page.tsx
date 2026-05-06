"use client";

import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
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
  if (!isSignedIn)
    return (
      <div className="p-8">
        Please sign in to join <strong>{roomName}</strong>.
      </div>
    );
  if (error) return <div className="p-8 text-red-600">Error: {error}</div>;
  if (!token || !wsUrl) return <div className="p-8">Connecting…</div>;

  return (
    <div data-lk-theme="default" style={{ height: "calc(100vh - 65px)" }}>
      <LiveKitRoom serverUrl={wsUrl} token={token} connect={true} audio={true} video={true}>
        <VideoConference />
        <RoomAudioRenderer />
        <ControlBar />
      </LiveKitRoom>
    </div>
  );
}
