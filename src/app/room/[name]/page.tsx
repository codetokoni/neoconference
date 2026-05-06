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
  useParticipants,
  useLocalParticipant,
} from "@livekit/components-react";
import { RoomEvent, Track, type Participant } from "livekit-client";
import "@livekit/components-styles";
import "./initials-overlay.css";

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
  const [showPeople, setShowPeople] = useState(false);

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
          onClick={() => setShowPeople((v) => !v)}
          className="px-3 py-1.5 text-xs rounded bg-white/90 hover:bg-white border shadow-sm"
          title="Show participants"
        >
          People
        </button>
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
        <InitialsOverlay />
        <RaiseHandButton />
        <VideoConference />
        <RoomAudioRenderer />
        {showPeople && (
          <ParticipantsPanel onClose={() => setShowPeople(false)} />
        )}
      </LiveKitRoom>
    </div>
  );
}

/**
 * Tags every participant tile with data-initials and a CSS color variable so
 * the stylesheet can render a colored circular avatar over the silhouette
 * when the camera is off. Re-runs whenever participants change.
 */
function InitialsOverlay() {
  const participants = useParticipants();

  useEffect(() => {
    const apply = () => {
      const tiles = document.querySelectorAll<HTMLElement>(
        ".lk-participant-tile"
      );
      tiles.forEach((tile) => {
        const nameEl = tile.querySelector<HTMLElement>(
          ".lk-participant-name"
        );
        const display = (nameEl?.textContent || "").trim() || "Guest";
        tile.setAttribute("data-initials", getInitials(display));
        tile.style.setProperty("--lk-initials-bg", stringToColor(display));
      });
    };
    apply();
    const id = window.setInterval(apply, 1500);
    return () => window.clearInterval(id);
  }, [participants]);

  return null;
}

function ParticipantsPanel({ onClose }: { onClose: () => void }) {
  const participants = useParticipants();
  const room = useRoomContext();
  const [raisedHands, setRaisedHands] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!room) return;
    const onData = (
      payload: Uint8Array,
      participant?: Participant
    ) => {
      try {
        const text = new TextDecoder().decode(payload);
        const msg = JSON.parse(text);
        if (msg?.type === "hand" && participant?.identity) {
          setRaisedHands((prev) => {
            const next = new Set(prev);
            if (msg.raised) next.add(participant.identity);
            else next.delete(participant.identity);
            return next;
          });
        }
      } catch {
        // ignore
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  return (
    <aside
      style={{
        position: "absolute",
        top: 48,
        right: 8,
        bottom: 8,
        width: 260,
        zIndex: 11,
        background: "rgba(17, 17, 24, 0.95)",
        color: "#fff",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid #2a2a33",
          fontSize: 13,
        }}
      >
        <strong>People ({participants.length})</strong>
        <button
          onClick={onClose}
          className="text-xs opacity-70 hover:opacity-100"
        >
          Close
        </button>
      </div>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          overflowY: "auto",
          flex: 1,
        }}
      >
        {participants.map((p) => {
          const display = p.name || p.identity;
          const initials = getInitials(display);
          const micOn = !p.getTrackPublication(Track.Source.Microphone)
            ?.isMuted;
          const camOn = !p.getTrackPublication(Track.Source.Camera)?.isMuted;
          const handUp = raisedHands.has(p.identity);
          return (
            <li
              key={p.identity}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                borderBottom: "1px solid #1d1d25",
                fontSize: 13,
              }}
            >
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: stringToColor(display),
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 600,
                  fontSize: 12,
                  color: "#fff",
                  flex: "0 0 auto",
                }}
              >
                {initials}
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {display}
                {p.isLocal ? " (you)" : ""}
              </span>
              {handUp && <span title="Hand raised">✋</span>}
              <span title={micOn ? "Mic on" : "Mic muted"}>
                {micOn ? "🎤" : "🔇"}
              </span>
              <span title={camOn ? "Camera on" : "Camera off"}>
                {camOn ? "🎥" : "📷"}
              </span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function RaiseHandButton() {
  const { localParticipant } = useLocalParticipant();
  const [raised, setRaised] = useState(false);

  const toggle = async () => {
    const next = !raised;
    setRaised(next);
    try {
      const payload = new TextEncoder().encode(
        JSON.stringify({ type: "hand", raised: next })
      );
      await localParticipant.publishData(payload, { reliable: true } as any);
    } catch (e) {
      console.error("publishData hand failed", e);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      title={raised ? "Lower hand" : "Raise hand"}
      style={{
        position: "absolute",
        left: 8,
        top: 8,
        zIndex: 10,
        padding: "6px 12px",
        borderRadius: 999,
        border: "none",
        background: raised ? "#fbbf24" : "rgba(255,255,255,0.92)",
        color: raised ? "#000" : "#111",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
      }}
    >
      {raised ? "✋ Lower hand" : "✋ Raise hand"}
    </button>
  );
}

function getInitials(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function stringToColor(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = input.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 60% 45%)`;
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
