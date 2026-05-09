"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser, RedirectToSignIn } from "@clerk/nextjs";
import {
  LiveKitRoom,
  VideoConference,
  RoomAudioRenderer,
  type LocalUserChoices,
  useRoomContext,
  useChat,
  useParticipants,
  useLocalParticipant,
} from "@livekit/components-react";
import MobileVideoConference from "@/components/MobileVideoConference";
import { RoomEvent, Track, type Participant } from "livekit-client";
import "@livekit/components-styles";
import "./initials-overlay.css";
import ApplyPrejoinChoices from "@/components/ApplyPrejoinChoices";
import MobileMoreMenu from "@/components/MobileMoreMenu";
import { RoomNameEntry } from "@/components/RoomNameEntry";
import ParticipantCountBadge from "@/components/ParticipantCountBadge";
import RoomIdleController from "@/components/RoomIdleController";
import GoLiveButton from "@/components/GoLiveButton";
import LiveCaptions from "@/components/LiveCaptions";
import ReactionsBar from "@/components/ReactionsBar";
import ChatPanel from "@/components/ChatPanel";
import RaiseHandButton from "@/components/RaiseHandButton";
import SpotlightOverlay from "@/components/SpotlightOverlay";
import SpeakerBadge from "@/components/SpeakerBadge";import Whiteboard from "@/components/Whiteboard"; import PollsPanel from "@/components/PollsPanel"; import WaitingRoomPanel from "@/components/WaitingRoomPanel";import BreakoutsPanel from "@/components/BreakoutsPanel";

type TokenResponse = { token: string; wsUrl: string };

export default function RoomPage({ params }: { params: { name: string } }) {
  const router = useRouter();
  const { isLoaded, isSignedIn, user } = useUser();
  const [token, setToken] = useState<string | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null); const [waitingState, setWaitingState] = useState<"pending" | "denied" | null>(null);
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [copied, setCopied] = useState(false);

  const roomName = decodeURIComponent(params.name);
  const searchParams = useSearchParams();
  const eventSlug = searchParams?.get("event") || undefined;
  // Per-tab LiveKit identity suffix so the same Clerk user can join from
  // multiple tabs/browsers without being kicked for duplicate identity.
  // Stable across refresh in the same tab via sessionStorage; unique per tab.
  const tabNonce = useMemo(() => {
    if (typeof window === "undefined") return "";
    const KEY = "nc:tabNonce";
    let n = window.sessionStorage.getItem(KEY);
    if (!n) {
      n = (crypto.randomUUID?.() || Math.random().toString(36).slice(2))
        .replace(/-/g, "")
        .slice(0, 16);
      window.sessionStorage.setItem(KEY, n);
    }
    return n;
  }, []);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !choices) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/livekit/token?room=${encodeURIComponent(roomName)}${eventSlug ? `&event=${encodeURIComponent(eventSlug)}` : ""}${tabNonce ? `&nonce=${encodeURIComponent(tabNonce)}` : ""}`,
          { cache: "no-store" }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (res.status === 403 && body?.error === "waiting_room") {
            if (!cancelled) {
              setWaitingState(body.status === "denied" ? "denied" : "pending");
            }
            try {
              await fetch("/api/waiting-room", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ op: "knock", slug: eventSlug }),
              });
            } catch {}
            return;
          }
          throw new Error(body.error || ("HTTP " + res.status));
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
  }, [isLoaded, isSignedIn, roomName, choices, eventSlug, waitingState]);

  // While waiting in the queue, re-knock every 4s. When the host admits us
  // the response flips to "admitted" and we clear waitingState which causes
  // the token-fetch effect above to re-run and pull a real LiveKit token.
  useEffect(() => {
    if (!eventSlug || waitingState !== "pending") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/waiting-room", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "knock", slug: eventSlug }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.status === "admitted") {
          setWaitingState(null);
        } else if (data.status === "denied") {
          setWaitingState("denied");
        }
      } catch {
        // ignore - try again next tick
      }
    };
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [eventSlug, waitingState]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  if (!isLoaded) return <div className="p-8">Loading\u2026</div>;

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
          \u2190 Back to home
        </a>
      </div>
    );
  }

  if (!choices) {
    const defaultUsername =
      user?.fullName ||
      user?.username ||
      user?.primaryEmailAddress?.emailAddress ||
      "";

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
          <RoomNameEntry roomName={roomName} defaultName={defaultUsername} onSubmit={(values) => setChoices(values as LocalUserChoices)} onCopyLink={copyLink} copied={copied} />
        </div>
      </div>
    );
  }

  if (waitingState) {
    return (
      <div className="min-h-[calc(100vh-65px)] flex flex-col items-center justify-center p-8 gap-3 text-center">
        <h1 className="text-xl font-semibold">
          {waitingState === "denied" ? "Entry denied" : "Waiting for the host…"}
        </h1>
        <p className="text-sm opacity-70 max-w-md">
          {waitingState === "denied"
            ? "The host did not let you in. Reach out to them if this looks wrong."
            : "We let the host know you’re here. You’ll join automatically once they admit you."}
        </p>
        <a href="/" className="mt-6 underline text-sm">
          ← Back to home
        </a>
      </div>
    );
  }
  if (!token || !wsUrl) return <div className="p-8">Connecting\u2026</div>;

  return (
    <RoomContainer
      token={token}
      wsUrl={wsUrl}
      roomName={roomName}
      eventSlug={eventSlug}
      choices={choices}
      onLeave={() => router.push("/")}
    />
  );
}

function RoomContainer({
  token,
  wsUrl,
  roomName,
  eventSlug,
  choices,
  onLeave,
}: {
  token: string;
  wsUrl: string;
  roomName: string;
  eventSlug?: string;
  choices: LocalUserChoices;
  onLeave: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const [showChat, setShowChat] = useState(false); const [showWhiteboard, setShowWhiteboard] = useState(false); const [showPolls, setShowPolls] = useState(false); const [showWaitingRoom, setShowWaitingRoom] = useState(false);
  const [showBreakouts, setShowBreakouts] = useState(false);
  const [hideSelf, setHideSelf] = useState(false);
  const [roomRole, setRoomRole] = useState<string>("guest");

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Fetch event role (host/cohost/speaker/attendee/viewer/guest) for chrome decisions.
  useEffect(() => {
    if (!eventSlug) return;
    let cancelled = false;
    fetch("/api/events/role?slug=" + encodeURIComponent(eventSlug), { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (!cancelled && j && typeof j.role === "string") setRoomRole(j.role); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [eventSlug]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const onDbl = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      const tile = target?.closest(".lk-participant-tile") as HTMLElement | null;
      if (!tile) return;
      ev.preventDefault();
      try {
        if (document.fullscreenElement === tile) {
          document.exitFullscreen();
        } else {
          tile.requestFullscreen();
        }
      } catch (e) {
        console.error("Tile fullscreen failed", e);
      }
    };
    root.addEventListener("dblclick", onDbl);
    return () => root.removeEventListener("dblclick", onDbl);
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
      data-hide-self={hideSelf ? "true" : "false"}
      style={{ height: "calc(100vh - 65px)", position: "relative" }}
    >
      <LiveKitRoom
        serverUrl={wsUrl}
        token={token}
        connect={true}
        audio={true}
        video={true}
        onDisconnected={onLeave}
      >
        <ApplyPrejoinChoices choices={choices} />
        <MobileMoreMenu />
        <div
        data-room-chrome="true" className="room-toolbar" style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 12, display: "flex", gap: 8, alignItems: "center" }}
      >
        <button
          type="button"
          onClick={() => setShowPeople((v) => !v)}
          className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
          title="Show participants"
        >
          People
        </button>
        <button
          type="button"
          data-room-chrome="true"
          onClick={() => setHideSelf((v) => !v)}
          className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
          title="Hide your own video"
        >
          {hideSelf ? "Show me" : "Hide me"}
        </button>
          <button
            type="button"
            data-room-chrome="true"
            onClick={() => setShowWhiteboard((v) => !v)}
            className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
            title="Toggle whiteboard"
          >
            {showWhiteboard ? "Close whiteboard" : "Whiteboard"}
          </button>
          <button
            type="button"
            data-room-chrome="true"
            onClick={() => setShowPolls((v) => !v)}
            className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
            title="Toggle polls"
          >
        
          {(roomRole === "host" || roomRole === "cohost") && (
            <button
              type="button"
              data-room-chrome="true"
              onClick={() => setShowWaitingRoom((v) => !v)}
              className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
              title="Toggle waiting room"
            >
              {showWaitingRoom ? "Close waiting" : "Waiting"}
            </button>
          )}
          {(roomRole === "host" || roomRole === "cohost") && (
            <button
              type="button"
              data-room-chrome="true"
              onClick={() => setShowBreakouts((v) => !v)}
              className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
              title="Toggle breakouts"
            >
              {showBreakouts ? "Close breakouts" : "Breakouts"}
            </button>
          )}    {showPolls ? "Close polls" : "Polls"}
          </button>
        <button
          type="button"
          onClick={copyLink}
          className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
          title="Copy room link"
        >
          {copied ? "Link copied!" : "Copy link"}
        </button>
        <button
          type="button"
          onClick={toggleFullscreen}
          className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
          title="Toggle fullscreen"
        >
          {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
        <ParticipantCountBadge />
        <RecordingControls roomName={roomName} />
        <GoLiveButton roomName={roomName} eventSlug={eventSlug} />
      </div>
      <RaiseHandButton isHost={roomRole === "host" || roomRole === "cohost"} />
      <SpotlightOverlay isHost={roomRole === "host" || roomRole === "cohost"} />
        <ChatTranscriptDownloader roomName={roomName} />
        <InitialsOverlay />
        <RoomIdleController /><MobileVideoConference />
        <RoomAudioRenderer />
        <LiveCaptions />
        <ReactionsBar />
        <ChatPanel eventId={roomName} open={showChat} onClose={() => setShowChat(false)} />
        <Whiteboard open={showWhiteboard} onClose={() => setShowWhiteboard(false)} />
        <PollsPanel open={showPolls} onClose={() => setShowPolls(false)} />
        <WaitingRoomPanel open={showWaitingRoom} onClose={() => setShowWaitingRoom(false)} eventSlug={eventSlug} isHost={roomRole === "host" || roomRole === "cohost"} />          <BreakoutsPanel open={showBreakouts} onClose={() => setShowBreakouts(false)} isHost={roomRole === "host" || roomRole === "cohost"} eventSlug={eventSlug} />
              <SpeakerBadge />
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
  // NUCLEAR: read names from useParticipants() (JWT source of truth) and
  // refuse to mark a tile "ready" until the real name has been present
  // for at least 600ms. Prevents any "GU"/"Guest User" placeholder flash.
  const participants = useParticipants();
  const firstSeenRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const PLACEHOLDERS = new Set(["", "guest", "guest user", "unknown", "?"]);
    const READY_DELAY_MS = 600;

    const seen = firstSeenRef.current;
    const now = Date.now();
    const liveIdentities = new Set<string>();
    for (const p of participants) {
      liveIdentities.add(p.identity);
      if (!seen.has(p.identity)) seen.set(p.identity, now);
    }
    for (const id of [...seen.keys()]) {
      if (!liveIdentities.has(id)) seen.delete(id);
    }

    const realNames = new Set<string>();
    for (const p of participants) {
      const n = (p.name || "").trim();
      if (n && !PLACEHOLDERS.has(n.toLowerCase())) realNames.add(n);
    }

    const seenValues = [...seen.values()];
    const earliestSeen = seenValues.length ? Math.min(...seenValues) : now;
    const enoughTimeElapsed = now - earliestSeen >= READY_DELAY_MS;

    const apply = () => {
      const tiles = document.querySelectorAll<HTMLElement>(
        ".lk-participant-tile"
      );
      tiles.forEach((tile) => {
        const nameEl = tile.querySelector<HTMLElement>(
          ".lk-participant-name"
        );
        const raw = (nameEl?.textContent || "").trim();
        const lower = raw.toLowerCase();

        const nameIsReal =
          raw.length > 0 &&
          !PLACEHOLDERS.has(lower) &&
          realNames.has(raw);

        if (!nameIsReal) {
          tile.removeAttribute("data-initials");
          tile.removeAttribute("data-initials-ready");
          tile.style.removeProperty("--lk-initials-bg");
          return;
        }

        tile.setAttribute("data-initials", getInitials(raw));
        tile.style.setProperty("--lk-initials-bg", stringToColor(raw));

        if (enoughTimeElapsed) {
          tile.setAttribute("data-initials-ready", "true");
        } else {
          tile.removeAttribute("data-initials-ready");
        }
      });
    };

    apply();
    const timeoutId = window.setTimeout(apply, READY_DELAY_MS + 50);

    const root = document.querySelector<HTMLElement>("[data-lk-theme]");
    if (!root) {
      const intervalId = window.setInterval(apply, 100);
      return () => {
        window.clearInterval(intervalId);
        window.clearTimeout(timeoutId);
      };
    }

    const observer = new MutationObserver(apply);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-lk-video-muted"],
    });

    return () => {
      observer.disconnect();
      window.clearTimeout(timeoutId);
    };
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
      data-room-chrome="true"
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
                {handUp && <span title="Hand raised">\u270B</span>}
              <span title={micOn ? "Mic on" : "Mic muted"}>
                {micOn ? "Mic on" : "Mic muted"}
              </span>
              <span title={camOn ? "Camera on" : "Camera off"}>
                {camOn ? "Camera on" : "Camera off"}
              </span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

/**
 * Record button + REC indicator banner + presigned download URL toast.
 *
 * Anyone in the room can start/stop a recording. State is broadcast to all
 * participants over the LiveKit data channel so everyone sees a red REC
 * banner while it's running.
 */
function RecordingControls({ roomName }: { roomName: string }) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();

  // Local recording state (this client started/stopped)
  const [egressId, setEgressId] = useState<string | null>(null);
  const [filepath, setFilepath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Globally observed recording state (any participant is recording)
  const [remoteRecording, setRemoteRecording] = useState<{
    by: string;
  } | null>(null);

  // Toast for download URL after stop
  const [toast, setToast] = useState<{
    message: string;
    url?: string;
  } | null>(null);

  const isRecording = !!egressId || !!remoteRecording;

  // Subscribe to recording state messages from other participants.
  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array, participant?: Participant) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg?.type === "recording") {
          if (msg.active) {
            setRemoteRecording({
              by: msg.by || participant?.name || participant?.identity || "Someone",
            });
          } else {
            setRemoteRecording(null);
          }
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

  const broadcast = async (active: boolean) => {
    try {
      const me =
        localParticipant.name || localParticipant.identity || "Someone";
      const payload = new TextEncoder().encode(
        JSON.stringify({ type: "recording", active, by: me })
      );
      await localParticipant.publishData(payload, { reliable: true } as any);
    } catch (e) {
      console.error("publishData recording failed", e);
    }
  };

  const start = async () => {
    if (busy || isRecording) return;
    setBusy(true);
    try {
      const res = await fetch("/api/livekit/egress/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room: roomName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setEgressId(data.egressId);
      setFilepath(data.filepath);
      setRemoteRecording({
        by: localParticipant.name || localParticipant.identity || "You",
      });
      await broadcast(true);
      setToast({ message: "Recording started" });
      setTimeout(() => setToast(null), 3000);
    } catch (e: any) {
      console.error("start recording failed", e);
      setToast({ message: `Could not start recording: ${e?.message || e}` });
      setTimeout(() => setToast(null), 5000);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (busy || !egressId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/livekit/egress/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ egressId, filepath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setEgressId(null);
      setFilepath(null);
      setRemoteRecording(null);
      await broadcast(false);
      if (data.downloadUrl) {
        setToast({
          message: "Recording ready (link valid for 24h)",
          url: data.downloadUrl,
        });
      } else {
        setToast({ message: "Recording stopped (file uploading\u2026)" });
        setTimeout(() => setToast(null), 5000);
      }
    } catch (e: any) {
      console.error("stop recording failed", e);
      setToast({ message: `Could not stop recording: ${e?.message || e}` });
      setTimeout(() => setToast(null), 5000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* REC banner shown to everyone while a recording is active */}
      {isRecording && (
        <div
          data-room-chrome="true"
          style={{
            position: "absolute",
            top: 8,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 11,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 999,
            background: "rgba(220, 38, 38, 0.95)",
            color: "#fff",
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 0.5,
            boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#fff",
              boxShadow: "0 0 6px #fff",
              animation: "lk-rec-pulse 1.2s ease-in-out infinite",
            }}
          />
          REC
          {remoteRecording?.by ? (
            <span style={{ fontWeight: 400, opacity: 0.9 }}>
              \u00B7 {remoteRecording.by}
            </span>
          ) : null}
        </div>
      )}

      {/* Record button: bottom-right floating */}
      <button
        type="button"
        data-room-chrome="true"
        onClick={egressId ? stop : start}
        disabled={busy}
        title={egressId ? "Stop recording" : "Start recording"}
        style={{
          position: "relative",
          padding: "6px 12px",
          borderRadius: 999,
          border: "none",
          background: egressId ? "#dc2626" : "#000",
          color: egressId ? "#fff" : "#fff",
          fontSize: 12,
          fontWeight: 600,
          cursor: busy ? "wait" : "pointer",
          opacity: busy ? 0.6 : 1,
          boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
        }}
      >
        {busy
          ? "\u2026"
          : egressId
          ? "\u25A0 Stop recording"
          : "\u25CF Record"}
      </button>

      {/* Toast (e.g. download URL) */}
      {toast && (
        <div
          data-room-chrome="true"
          style={{
            position: "absolute",
            bottom: 80,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 12,
            maxWidth: 420,
            padding: "10px 14px",
            background: "rgba(17,17,24,0.95)",
            color: "#fff",
            borderRadius: 8,
            fontSize: 13,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span>{toast.message}</span>
          {toast.url && (
            <a
              href={toast.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: "#60a5fa",
                textDecoration: "underline",
                fontWeight: 600,
              }}
            >
              Download
            </a>
          )}
          <button
            onClick={() => setToast(null)}
            style={{
              marginLeft: 6,
              background: "transparent",
              border: "none",
              color: "#fff",
              cursor: "pointer",
              opacity: 0.7,
            }}
          >
            \u25CF
          </button>
        </div>
      )}

      {/* Pulse keyframes */}
      <style>{`@keyframes lk-rec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </>
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



