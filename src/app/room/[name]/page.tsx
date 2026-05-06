"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser, RedirectToSignIn } from "@clerk/nextjs";
import {
  LiveKitRoom,
  VideoConference,
  RoomAudioRenderer,
  PreJoin,
  type LocalUserChoices,
  useRoomContext,
  useChat,
} from "@livekit/components-react";
import { RoomEvent, type Room } from "livekit-client";
import "@livekit/components-styles";

type TokenResponse = { token: string; wsUrl: string };

export default function RoomPage({ params }: { params: { name: string } }) {
  const router = useRouter();
  const { isLoaded, isSignedIn, user } = useUser();
  const [token, setToken] = useState<string | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [copied, setCopied] = useState(false);

  const roomName = decodeURIComponent(params.name);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !choices) return;
    let cancelled = false;
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
        const data = (await res.json()) as TokenResponse;
        if (cancelled) return;
        setToken(data.token);
        setWsUrl(data.wsUrl);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to fetch token");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, roomName, choices]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  if (!isLoaded) return <div className="p-8">Loading…</div>;

  if (!isSignedIn) {
    return (
      <RedirectToSignIn
        redirectUrl={
          typeof window !== "undefined" ? window.location.pathname : "/"
        }
      />
    );
  }

  if (error) {
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
  }

  if (!choices) {
    const defaultUsername =
      user?.fullName ||
      user?.username ||
      user?.primaryEmailAddress?.emailAddress ||
      "Guest";
    return (
      <div className="min-h-[calc(100vh-65px)] flex flex-col items-center justify-center p-4 gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-600">Room:</span>
          <strong>{roomName}</strong>
          <button
            type="button"
            onClick={copyLink}
            className="ml-2 px-2 py-1 text-xs border rounded hover:bg-gray-50"
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>
        <div data-lk-theme="default" className="w-full max-w-xl">
          <PreJoin
            defaults={{
              username: defaultUsername,
              videoEnabled: true,
              audioEnabled: true,
            }}
            onSubmit={(values) => setChoices(values)}
            onError={(err) => console.error("PreJoin error", err)}
          />
        </div>
      </div>
    );
  }

  if (!token || !wsUrl) return <div className="p-8">Connecting…</div>;

  return (
    <RoomContainer
      token={token}
      wsUrl={wsUrl}
      roomName={roomName}
      choices={choices}
      onLeave={() => router.push("/")}
    />
  );
}

function RoomContainer({
  token,
  wsUrl,
  roomName,
  choices,
  onLeave,
}: {
  token: string;
  wsUrl: string;
  roomName: string;
  choices: LocalUserChoices;
  onLeave: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await containerRef.current?.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (e) {
      console.error("Fullscreen toggle failed", e);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div
      ref={containerRef}
      data-lk-theme="default"
      style={{ height: "calc(100vh - 65px)", position: "relative" }}
    >
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 10,
          display: "flex",
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={copyLink}
          className="px-3 py-1.5 text-xs rounded bg-white/90 hover:bg-white border shadow-sm"
          title="Copy room link"
        >
          {copied ? "Link copied!" : "Copy link"}
        </button>
        <button
          type="button"
          onClick={toggleFullscreen}
          className="px-3 py-1.5 text-xs rounded bg-white/90 hover:bg-white border shadow-sm"
          title="Toggle fullscreen"
        >
          {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>
      <LiveKitRoom
        serverUrl={wsUrl}
        token={token}
        connect={true}
        audio={choices.audioEnabled}
        video={choices.videoEnabled}
        onDisconnected={onLeave}
      >
        <ChatTranscriptDownloader roomName={roomName} />
        <VideoConference />
        <RoomAudioRenderer />
      </LiveKitRoom>
    </div>
  );
}

/**
 * Inside <LiveKitRoom>: subscribes to chat messages and, on disconnect,
 * triggers a download of the transcript as a .txt file.
 */
function ChatTranscriptDownloader({ roomName }: { roomName: string }) {
  const room = useRoomContext();
  const { chatMessages } = useChat();
  const messagesRef = useRef(chatMessages);

  useEffect(() => {
    messagesRef.current = chatMessages;
  }, [chatMessages]);

  useEffect(() => {
    if (!room) return;
    const handleDisconnect = () =>
      downloadTranscript(roomName, messagesRef.current);
    room.on(RoomEvent.Disconnected, handleDisconnect);
    return () => {
      room.off(RoomEvent.Disconnected, handleDisconnect);
    };
  }, [room, roomName]);

  return null;
}

function downloadTranscript(
  roomName: string,
  messages: ReadonlyArray<{
    from?: { identity?: string; name?: string };
    message: string;
    timestamp: number;
  }>
) {
  if (!messages || messages.length === 0) return;
  const lines = messages.map((m) => {
    const time = new Date(m.timestamp).toISOString();
    const who = m.from?.name || m.from?.identity || "unknown";
    return `[${time}] ${who}: ${m.message}`;
  });
  const blob = new Blob([lines.join("\n")], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `neoconference-${roomName}-${new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-")}.txt`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}
