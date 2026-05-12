"use client";

import { useEffect, useMemo, useRef, useState } from "react";import { createPortal } from "react-dom";
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
import HostMenuOverlay from "@/components/HostMenuOverlay";
import MediaRequestPrompt from "@/components/MediaRequestPrompt";
import { RoomEvent, Track, type Participant } from "livekit-client";
import "@livekit/components-styles";
import "./initials-overlay.css";
import ApplyPrejoinChoices from "@/components/ApplyPrejoinChoices";
import { RoomNameEntry } from "@/components/RoomNameEntry";
import ParticipantCountBadge from "@/components/ParticipantCountBadge";
import RoomIdleController from "@/components/RoomIdleController";
import GoLiveButton from "@/components/GoLiveButton";
import LiveCaptions from "@/components/LiveCaptions";
import ReactionsBar from "@/components/ReactionsBar";
import NetworkQualityToast from "@/components/NetworkQualityToast";
import KeyboardShortcutsHelp from "@/components/KeyboardShortcutsHelp";
import LeaveConfirmModal from "@/components/LeaveConfirmModal";
import SettingsModal from "@/components/SettingsModal";
import ChatPanel from "@/components/ChatPanel";
import FloatingVideoButton from "@/components/FloatingVideoButton";import BackgroundBlurButton from "@/components/BackgroundBlurButton";
import PictureInPictureButton from "@/components/PictureInPictureButton";
import DeviceSelectListener from "@/components/DeviceSelectListener";
import RaiseHandButton from "@/components/RaiseHandButton";
import SpotlightOverlay from "@/components/SpotlightOverlay";
import SpeakerBadge from "@/components/SpeakerBadge";import Whiteboard from "@/components/Whiteboard"; import PollsPanel from "@/components/PollsPanel";import ManageParticipantsPanel from "@/components/ParticipantsPanel"; import TileRoleBadges from "@/components/TileRoleBadges"; import WaitingRoomPanel from "@/components/WaitingRoomPanel";import BreakoutsPanel from "@/components/BreakoutsPanel";
import PlanGateOverlay from "@/components/PlanGateOverlay";

type TokenResponse = { token: string; wsUrl: string };

export default function RoomPage({ params }: { params: { name: string } }) {
  const router = useRouter();
  const { isLoaded, isSignedIn, user } = useUser();
  const [token, setToken] = useState<string | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null); const [waitingState, setWaitingState] = useState<"pending" | "denied" | null>(null); const [waitForHost, setWaitForHost] = useState<boolean>(false);
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [audioOut, setAudioOut] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const roomName = decodeURIComponent(params.name);
  const searchParams = useSearchParams();
  // Fall back to using the path slug as the event slug when ?event= is missing.
  // This makes URLs like /room/<slug> (no query) still resolve owner+role correctly,
  // and lets users type a renamed URL without remembering the query string.
  const eventSlug = searchParams?.get("event") || roomName || undefined;
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
          if (res.status === 403 && body?.error === "wait_for_host") {
            if (!cancelled) {
              setWaitForHost(true);
            }
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
  }, [isLoaded, isSignedIn, roomName, choices, eventSlug, waitingState, waitForHost]);

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

  // While waiting for host, poll /api/events/host-present every 3s. When the host arrives,
  // clear waitForHost which causes the token-fetch effect above to re-run.
  useEffect(() => {
    if (!waitForHost || !eventSlug) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/events/host-present?slug=${encodeURIComponent(eventSlug)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.hostPresent) {
          setWaitForHost(false);
        }
      } catch {
        // ignore - try again next tick
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [eventSlug, waitForHost]);

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
          <RoomNameEntry roomName={roomName} defaultName={defaultUsername} onSubmit={(values) => { setChoices(values as LocalUserChoices); setAudioOut((values as { audioOutputDeviceId?: string }).audioOutputDeviceId || null); }} onCopyLink={copyLink} copied={copied} />
        </div>
      </div>
    );
  }

  if (waitForHost) {
    return (
      <div className="min-h-[calc(100vh-65px)] flex flex-col items-center justify-center p-8 gap-4 text-center">
        <div className="text-3xl">⏳</div>
        <h1 className="text-xl font-semibold">Waiting for the host to start the meeting</h1>
        <p className="text-sm opacity-70 max-w-md">
          The meeting hasn’t started yet. You’ll join automatically as soon as the host arrives.
        </p>
        <div className="text-xs opacity-50">Checking every few seconds…</div>
        <a href="/" className="mt-6 underline text-sm">← Back to home</a>
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
  if (!token || !wsUrl) return <div className="p-8">Connecting…</div>;

  return (
    <RoomContainer
      token={token}
      wsUrl={wsUrl}
      roomName={roomName}
      eventSlug={eventSlug}
      choices={choices}
      audioOutputDeviceId={audioOut}
      onLeave={() => router.push("/")}
    />
  );
}

/**
 * RoleMetadataListener
 *
 * Subscribes to ParticipantMetadataChanged events on the local participant so that
 * server-side role changes (via /api/livekit/moderate makeCohost / demoteToAttendee)
 * are reflected in the room UI without a rejoin. Must be rendered INSIDE <LiveKitRoom>.
 */
function RoleMetadataListener({ onRoleChange }: { onRoleChange: (role: string) => void }) {
  const room = useRoomContext();

  useEffect(() => {
    if (!room) return;
    const apply = (_metadata: string | undefined, participant: Participant) => {
      try {
        if (participant.identity !== room.localParticipant.identity) return;
        const md = participant.metadata ? JSON.parse(participant.metadata) : null;
        if (md && typeof md.role === "string") onRoleChange(md.role);
      } catch {
        // ignore malformed metadata
      }
    };
    try {
      const md = room.localParticipant.metadata ? JSON.parse(room.localParticipant.metadata) : null;
      if (md && typeof md.role === "string") onRoleChange(md.role);
    } catch {}
    room.on(RoomEvent.ParticipantMetadataChanged, apply);
    return () => {
      room.off(RoomEvent.ParticipantMetadataChanged, apply);
    };
  }, [room, onRoleChange]);

  return null;
}

/**
 * RenameRedirectListener
 *
 * Listens for an "event_renamed" data packet from the rename API and hard-
 * redirects everyone in the old LiveKit room to the new URL. Must be rendered
 * INSIDE <LiveKitRoom> so useRoomContext() resolves.
 */
function RenameRedirectListener() {
  const room = useRoomContext();
  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array) => {
      try {
        const txt = new TextDecoder().decode(payload);
        const msg = JSON.parse(txt) as { type?: string; roomUrl?: string };
        if (msg && msg.type === "event_renamed" && typeof msg.roomUrl === "string") {
          window.location.href = msg.roomUrl;
        }
      } catch {
        /* ignore non-JSON packets */
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);
  return null;
}

/**
 * RenameUrlButton
 *
 * Host-only floating chip that lets the host rename the meeting URL/slug.
 * Old links keep working as aliases. Calling the API broadcasts an
 * event_renamed packet so all current participants redirect to the new URL.
 */
function RenameUrlButton({
  roomRole,
  eventSlug,
}: {
  roomRole: string;
  eventSlug?: string;
}) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (roomRole !== "host" || !eventSlug) return null;
  const submit = async () => {
    const cleaned = (next || "").trim().toLowerCase();
    if (!cleaned) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/events/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: eventSlug, newSlug: cleaned }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; roomUrl?: string };
      if (!res.ok || !j.ok || !j.roomUrl) {
        setErr(j.error || "rename_failed");
        setBusy(false);
        return;
      }
      window.location.href = j.roomUrl;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "network_error");
      setBusy(false);
    }
  };
  return (
    <div className="fixed top-14 right-4 z-40 flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="px-2.5 py-1 rounded-full border border-cyan-300/40 bg-cyan-500/15 text-cyan-100 text-[11px] uppercase tracking-wider hover:bg-cyan-500/25 transition pointer-events-auto"
        title="Rename this meeting's URL"
      >
        Rename URL
      </button>
      {open && (
        <div className="rounded-xl border border-white/15 bg-zinc-900/95 backdrop-blur p-3 w-72 shadow-xl pointer-events-auto">
          <div className="text-[11px] uppercase tracking-wider text-white/60 mb-1">
            New slug
          </div>
          <input
            type="text"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="my-meeting"
            className="w-full px-2 py-1.5 rounded bg-black/40 border border-white/10 text-sm text-white outline-none focus:border-cyan-300/50"
            autoFocus
          />
          <div className="text-[10px] text-white/50 mt-1">
            Lowercase letters, numbers, and dashes. Old link will keep working.
          </div>
          {err && (
            <div className="text-[11px] text-rose-300 mt-2">{err}</div>
          )}
          <div className="flex justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-2 py-1 rounded text-[12px] text-white/70 hover:text-white"
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              className="px-3 py-1 rounded bg-cyan-500/80 hover:bg-cyan-500 text-[12px] text-white"
              disabled={busy || !next.trim()}
            >
              {busy ? "Renaming…" : "Rename"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RoomContainer({
  token,
  wsUrl,
  roomName,
  eventSlug,
  choices,
  onLeave,
  audioOutputDeviceId,
}: {
  token: string;
  wsUrl: string;
  roomName: string;
  eventSlug?: string;
  choices: LocalUserChoices;
  onLeave: () => void;
  audioOutputDeviceId: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showChat, setShowChat] = useState(false); const [showWhiteboard, setShowWhiteboard] = useState(false); const [showPolls, setShowPolls] = useState(false); const [showParticipants, setShowParticipants] = useState(false); const [showWaitingRoom, setShowWaitingRoom] = useState(false);
  const [showBreakouts, setShowBreakouts] = useState(false);
    type PanelName = "chat" | "whiteboard" | "polls" | "participants" | "waitingRoom" | "breakouts";
    const openPanel = (name: PanelName | null) => {
    setShowChat(name === "chat");
    setShowWhiteboard(name === "whiteboard");
    setShowPolls(name === "polls");
    setShowParticipants(name === "participants");
    setShowWaitingRoom(name === "waitingRoom");
    setShowBreakouts(name === "breakouts");
    };
  const [hideSelf, setHideSelf] = useState(false);
    const [captionsEnabled, setCaptionsEnabled] = useState(false);
    useEffect(() => {
      try {
        const v = window.localStorage.getItem("neo:captions-enabled");
        if (v === "1") setCaptionsEnabled(true);
      } catch {}
    }, []);
    useEffect(() => {
      try {
        window.localStorage.setItem("neo:captions-enabled", captionsEnabled ? "1" : "0");
      } catch {}
    }, [captionsEnabled]);
    // Settings → Video tab can toggle captions via this event.
    useEffect(() => {
      const onToggle = () => setCaptionsEnabled((v) => !v);
      window.addEventListener("neoconf:captions:toggle", onToggle as EventListener);
      return () => window.removeEventListener("neoconf:captions:toggle", onToggle as EventListener);
    }, []);
  const [roomRole, setRoomRole] = useState<string>("guest");
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);

  const [pendingKnockCount, setPendingKnockCount] = useState(0);
  const prevKnockCountRef = useRef(0);
  const knockAudioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const isHostOrCohost = roomRole === "host" || roomRole === "cohost";
    if (!isHostOrCohost || !eventSlug || showWaitingRoom) {
      prevKnockCountRef.current = 0;
      return;
    }
    let cancelled = false;
    const playChime = () => {
      try {
        const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) return;
        if (!knockAudioCtxRef.current) knockAudioCtxRef.current = new Ctor();
        const ctx = knockAudioCtxRef.current!;
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const now = ctx.currentTime;
        [880, 1320].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, now + i * 0.18);
          gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.18 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.15);
          osc.connect(gain).connect(ctx.destination);
          osc.start(now + i * 0.18);
          osc.stop(now + i * 0.18 + 0.16);
        });
      } catch {}
    };
    const tick = async () => {
      try {
        const res = await fetch(`/api/waiting-room?slug=${encodeURIComponent(eventSlug)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const entries = Array.isArray(data.entries) ? data.entries : [];
        const count = entries.filter((e: any) => e.status === "pending").length;
        setPendingKnockCount(count);
        if (count > prevKnockCountRef.current) playChime();
        prevKnockCountRef.current = count;
      } catch {}
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [roomRole, eventSlug, showWaitingRoom]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);


  // Auto-open Polls panel when a peer dispatches the neo-open-polls event
  // (fired from the new-poll notification toast inside PollsPanel).
  useEffect(() => {
    const onOpen = () => setShowPolls(true);
    window.addEventListener('neo-open-polls', onOpen as EventListener);
    return () => window.removeEventListener('neo-open-polls', onOpen as EventListener);
  }, []);
  // Fetch event role (host/cohost/speaker/attendee/viewer/guest) for chrome decisions.
  useEffect(() => {
    if (!eventSlug) return;
    let cancelled = false;
    // Retry on viewer/guest a few times — handles Clerk session hydration race
    // and KV eventual-consistency right after instant-meeting creation, so the
    // owner reliably resolves to "host" instead of being stuck on the first
    // unauthenticated/empty response.
    const delays = [0, 400, 900, 1800, 3500];
    let attempt = 0;
    const tick = () => {
      if (cancelled) return;
      fetch("/api/events/role?slug=" + encodeURIComponent(eventSlug), { cache: "no-store" })
        .then((r) => r.ok ? r.json() : null)
        .then((j) => {
          if (cancelled) return;
          if (j && typeof j.role === "string") {
            setRoomRole(j.role);
            setOwnerUserId(typeof j.ownerUserId === "string" ? j.ownerUserId : null);
            const isElevated = j.role === "host" || j.role === "cohost" || j.role === "speaker";
            if (!isElevated && attempt < delays.length - 1) {
              attempt += 1;
              setTimeout(tick, delays[attempt]);
            }
          } else if (attempt < delays.length - 1) {
            attempt += 1;
            setTimeout(tick, delays[attempt]);
          }
        })
        .catch(() => {
          if (!cancelled && attempt < delays.length - 1) {
            attempt += 1;
            setTimeout(tick, delays[attempt]);
          }
        });
    };
    tick();
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
        <RoleMetadataListener onRoleChange={setRoomRole} />
        <TileRoleBadges ownerUserId={ownerUserId} />
        <ApplyPrejoinChoices choices={choices} />
        <AudioOutputSwitcher deviceId={audioOutputDeviceId} />
        <div
        data-room-chrome="true" className="room-toolbar" style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 12, display: "flex", gap: 8, alignItems: "center" }}
      >
        <button
          type="button"
          onClick={() => openPanel(showParticipants ? null : "participants")}
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
              onClick={() => setCaptionsEnabled((v) => !v)}
              aria-pressed={captionsEnabled}
              className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
              title={captionsEnabled ? "Disable live captions" : "Enable live captions"}
            >
              {captionsEnabled ? "CC on" : "CC off"}
        </button>
            {/* Toolbar zoo cleanup: these features are now reached via Settings (⚙ bottom-right) and keyboard shortcuts (PiP: Alt+P). Kept mounted so their listeners and persisted prefs stay alive. */}
            <div aria-hidden="true" style={{ display: "none" }} data-toolbar-zoo="true">
              <BackgroundBlurButton />
              <PictureInPictureButton />
              <DeviceSwitcher />
            </div>
          <button
            type="button"
            data-room-chrome="true"
            onClick={() => openPanel(showWhiteboard ? null : "whiteboard")}
            className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
            title="Toggle whiteboard"
          >
            {showWhiteboard ? "Close whiteboard" : "Whiteboard"}
          </button>
          <button
            type="button"
            data-room-chrome="true"
            onClick={() => openPanel(showChat ? null : "chat")}
            className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
            title="Toggle chat"
        >
          {showChat ? "Close chat" : "Chat"}
        </button>
          <FloatingVideoButton />
          <button
            type="button"
            data-room-chrome="true"
            onClick={() => openPanel(showPolls ? null : "polls")}
            className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
            title="Toggle polls"
          >
            {showPolls ? "Close polls" : "Polls"}
          </button>
        
          {(roomRole === "host" || roomRole === "cohost") && (
            <button
              type="button"
              data-room-chrome="true"
              onClick={() => openPanel(showWaitingRoom ? null : "waitingRoom")}
              className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
              title="Toggle waiting room"
            >
              {showWaitingRoom ? "Close waiting" : (pendingKnockCount > 0 ? `Waiting (${pendingKnockCount})` : "Waiting")}
            </button>
          )}
          {(roomRole === "host" || roomRole === "cohost") && (
            <button
              type="button"
              data-room-chrome="true"
              onClick={() => openPanel(showBreakouts ? null : "breakouts")}
              className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
              title="Toggle breakouts"
            >
              {showBreakouts ? "Close breakouts" : "Breakouts"}
            </button>
          )}
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
        <RecordingControls roomName={roomName} roomRole={roomRole} />
        <GoLiveButton roomName={roomName} eventSlug={eventSlug} />
      </div>
      <RaiseHandButton isHost={roomRole === "host" || roomRole === "cohost"} />
      <SpotlightOverlay isHost={roomRole === "host" || roomRole === "cohost"} />
        <ChatTranscriptDownloader roomName={roomName} />
        <InitialsOverlay />
        <RoomIdleController /><MobileVideoConference />
        <ConnectionStatsOverlay />
        <HostMenuOverlay isHost={roomRole === "host" || roomRole === "cohost"} slug={eventSlug ?? ""} />
        <MediaRequestPrompt />
        <RoomAudioRenderer />
        <LiveCaptions enabled={captionsEnabled} />
        <ReactionsBar />
        <NetworkQualityToast />
        <KeyboardShortcutsHelp />
        <LeaveConfirmModal isHost={roomRole === "host" || roomRole === "cohost"} eventSlug={eventSlug} />
        <SettingsModal />
        <DeviceSelectListener />
        <ChatPanel eventId={roomName} open={showChat} onClose={() => setShowChat(false)} isHost={roomRole === 'host' || roomRole === 'cohost'} />
        <Whiteboard open={showWhiteboard} onClose={() => setShowWhiteboard(false)} />
        <PollsPanel open={showPolls} onClose={() => setShowPolls(false)} />
        <ManageParticipantsPanel open={showParticipants} onClose={() => setShowParticipants(false)} isHost={roomRole === "host" || roomRole === "cohost"} slug={eventSlug ?? ""} ownerUserId={ownerUserId} />
        <WaitingRoomPanel open={showWaitingRoom} onClose={() => setShowWaitingRoom(false)} eventSlug={eventSlug} isHost={roomRole === "host" || roomRole === "cohost"} />          <BreakoutsPanel open={showBreakouts} onClose={() => setShowBreakouts(false)} isHost={roomRole === "host" || roomRole === "cohost"} eventSlug={eventSlug} /><PlanGateOverlay />
              <SpeakerBadge />
        <RenameRedirectListener />
        <RenameUrlButton roomRole={roomRole} eventSlug={eventSlug} />
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

/**
 * Record button + REC indicator banner + presigned download URL toast.
 *
 * Anyone in the room can start/stop a recording. State is broadcast to all
 * participants over the LiveKit data channel so everyone sees a red REC
 * banner while it's running.
 */
function RecordingControls({ roomName, roomRole }: { roomName: string; roomRole: string | null }) {
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

  // Recording approval state: when a non-host clicks Record, they wait on host's response.
  const [recordPending, setRecordPending] = useState<"asking" | null>(null);
  // When a non-host requests recording, hosts see this approval prompt.
  const [recordApproval, setRecordApproval] = useState<{
    fromIdentity: string;
    fromName: string;
  } | null>(null);

  const isRecording = !!egressId || !!remoteRecording;

  // Recording duration tracking (PR #24): wall-clock since the local
  // start, or since first observing a remote recording flip on.
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [recordingNow, setRecordingNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (isRecording) {
      setRecordingStartedAt((prev) => prev ?? Date.now());
      const t = setInterval(() => setRecordingNow(Date.now()), 1000);
      return () => clearInterval(t);
    } else {
      setRecordingStartedAt(null);
    }
  }, [isRecording]);
  const recordingElapsed = (() => {
    if (!isRecording || !recordingStartedAt) return null;
    const total = Math.max(0, Math.floor((recordingNow - recordingStartedAt) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => n.toString().padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  })();

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
          } else if (msg?.type === "record_request") {
            if (roomRole === "host" || roomRole === "cohost") {
              setRecordApproval({
                fromIdentity: String(msg.from || participant?.identity || ""),
                fromName: String(msg.fromName || participant?.name || participant?.identity || "Someone"),
              });
            }
          } else if (msg?.type === "record_request_response") {
            const myIdentity = (room as any).localParticipant?.identity;
            if (msg.to && msg.to === myIdentity) {
              if (msg.ok) {
                setRecordPending(null);
                doStart();
              } else {
                setRecordPending(null);
                setToast({ message: "Recording denied by host" });
                setTimeout(() => setToast(null), 4000);
              }
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
  }, [room, roomRole]);

  // Expose record toggle to MobileControlBar so it can trigger this directly
  // instead of proxying a .click() to the (CSS-hidden) top-toolbar button.
  useEffect(() => {
    (window as any).__ncRecordToggle = () => {
      if (busy) return;
      if (egressId) {
        stop();
      } else {
        start();
      }
    };
    return () => {
      try { delete (window as any).__ncRecordToggle; } catch {}
    };
  });

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

  const doStart = async () => {
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

  // Send a record_request to all hosts and wait for a record_request_response.
  const requestRecord = async () => {
    if (busy || isRecording) return;
    try {
      const me =
        localParticipant.name || localParticipant.identity || "Someone";
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "record_request",
          from: localParticipant.identity,
          fromName: me,
        }),
      );
      await localParticipant.publishData(payload, { reliable: true } as any);
      setRecordPending("asking");
      setToast({ message: "Waiting for host approval…" });
      // Auto-clear pending state after 30s if no response
      setTimeout(() => {
        setRecordPending((p) => {
          if (p === "asking") {
            setToast({ message: "No response from host" });
            setTimeout(() => setToast(null), 4000);
            return null;
          }
          return p;
        });
      }, 30000);
    } catch (e) {
      console.error("requestRecord failed", e);
    }
  };

  // Host/cohost decision: respond Allow / Deny to a pending record_request.
  const respondRecord = async (ok: boolean) => {
    const target = recordApproval;
    if (!target) return;
    try {
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "record_request_response",
          to: target.fromIdentity,
          ok,
        }),
      );
      await localParticipant.publishData(payload, { reliable: true } as any);
    } catch (e) {
      console.error("respondRecord failed", e);
    } finally {
      setRecordApproval(null);
    }
  };

  // Public start(): hosts and cohosts start immediately; everyone else has to ask.
  const start = async () => {
    if (roomRole === "host" || roomRole === "cohost") {
      await doStart();
    } else {
      await requestRecord();
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
        setToast({ message: "Recording stopped (file uploading…)" });
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
          REC          {recordingElapsed ? (
            <span style={{ fontWeight: 600, opacity: 0.95, marginLeft: 4 }}>
              {recordingElapsed}
            </span>
          ) : null}

          {remoteRecording?.by ? (
            <span style={{ fontWeight: 400, opacity: 0.9 }}>
              · {remoteRecording.by}
            </span>
          ) : null}
        </div>
      )}

      {/* Recording approval modal (host/cohost view) */}
      {recordApproval && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9998,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
          }}
        >
          <div
            style={{
              width: "100%", maxWidth: 360, background: "#111", color: "#fff",
              borderRadius: 14, padding: 16, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
              {recordApproval.fromName} wants to record this meeting
            </div>
            <div style={{ fontSize: 13, color: "#bbb", marginBottom: 16 }}>
              Allow to start recording. Deny to block this request.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => respondRecord(false)}
                style={{
                  padding: "10px 14px", borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.18)", background: "transparent",
                  color: "#fff", fontWeight: 600, cursor: "pointer",
                }}
              >Deny</button>
              <button
                type="button"
                onClick={() => respondRecord(true)}
                style={{
                  padding: "10px 14px", borderRadius: 10, border: "none",
                  background: "#22c55e", color: "#0a0a0a", fontWeight: 700, cursor: "pointer",
                }}
              >Allow</button>
            </div>
          </div>
        </div>
      )}
            {/* Record button: bottom-right floating */}
      <button
        type="button"
        data-room-chrome="true"
        onClick={egressId ? stop : start}
        disabled={busy || recordPending === "asking"}
        title={egressId ? "Stop recording" : recordPending === "asking" ? "Waiting for host approval…" : "Start recording"}
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
          ? "…"
          : recordPending === "asking"
          ? "⏳ Waiting…"
          : egressId
          ? "■ Stop recording"
          : "● Record"}
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
            ●
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




/**
 * AudioOutputSwitcher
 *
 * Applies the user's prejoin speaker (audiooutput) choice once the local
 * Room is connected and re-applies if the device id changes mid-call.
 * Silently no-ops on browsers without setSinkId support.
 */
function AudioOutputSwitcher({ deviceId }: { deviceId: string | null }) {
  const room = useRoomContext();
  useEffect(() => {
    if (!room || !deviceId) return;
    let cancelled = false;
    const apply = async () => {
      try {
        await room.switchActiveDevice("audiooutput", deviceId);
      } catch {
        // not supported on this browser, or device gone — ignore
      }
    };
    if (room.state === "connected") {
      apply();
    }
    const onConnected = () => { if (!cancelled) apply(); };
    room.on(RoomEvent.Connected, onConnected);
    return () => {
      cancelled = true;
      room.off(RoomEvent.Connected, onConnected);
    };
  }, [room, deviceId]);
  return null;
}

/**
 * DeviceSwitcher
 *
 * In-room toolbar control that opens a themed popover with three sections
 * (Camera / Microphone / Speaker), each listing available devices with a
 * checkmark on the currently active one. Selecting an entry calls
 * room.switchActiveDevice() and persists the choice to the same
 * neoconf:device:* localStorage keys used by the prejoin picker, so the
 * prejoin and in-room agree on the active device across sessions.
 *
 * - Listens to navigator.mediaDevices.devicechange so plug/unplug refreshes
 *   the list live.
 * - Feature-detects HTMLMediaElement.setSinkId; when unavailable (Firefox /
 *   Safari), hides the Speaker section and shows an explanatory hint.
 * - Full a11y: aria-haspopup, aria-expanded, role=listbox / option,
 *   Escape closes, click-outside dismisses, focus moves to the popover.
 */
function DeviceSwitcher() {
  const room = useRoomContext();
  const [open, setOpen] = useState(false);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [outs, setOuts] = useState<MediaDeviceInfo[]>([]);
  const [activeCam, setActiveCam] = useState<string | null>(null);
  const [activeMic, setActiveMic] = useState<string | null>(null);
  const [activeOut, setActiveOut] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Feature detect setSinkId for the Speaker section.
  const speakerSupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    try {
      const proto = (window as any).HTMLMediaElement?.prototype;
      return !!(proto && typeof proto.setSinkId === "function");
    } catch { return false; }
  }, []);

  // Refresh device list (post-permission labels are populated).
  const refresh = async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setCams(list.filter((d) => d.kind === "videoinput"));
      setMics(list.filter((d) => d.kind === "audioinput"));
      setOuts(list.filter((d) => d.kind === "audiooutput"));
    } catch {
      // ignore — likely no permission yet
    }
  };

  // Read currently-active device IDs from LiveKit Room (defensive against
  // version differences: getActiveDevice may not exist on older builds).
  const readActive = () => {
    try {
      const r: any = room;
      if (!r) return;
      if (typeof r.getActiveDevice === "function") {
        setActiveCam(r.getActiveDevice("videoinput") || null);
        setActiveMic(r.getActiveDevice("audioinput") || null);
        setActiveOut(r.getActiveDevice("audiooutput") || null);
      }
    } catch {}
  };

  useEffect(() => {
    refresh();
    readActive();
    const onChange = () => { refresh(); readActive(); };
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep checkmarks in sync if LiveKit changes the active device for us
  // (e.g. an unplugged device caused an automatic fallback).
  useEffect(() => {
    if (!room) return;
    const onActive = (kind: string, deviceId: string) => {
      if (kind === "videoinput") setActiveCam(deviceId || null);
      else if (kind === "audioinput") setActiveMic(deviceId || null);
      else if (kind === "audiooutput") setActiveOut(deviceId || null);
    };
    try { (room as any).on?.("activeDeviceChanged", onActive); } catch {}
    return () => { try { (room as any).off?.("activeDeviceChanged", onActive); } catch {} };
  }, [room]);

  // Close on Escape / click-outside.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  // When the menu opens, refresh once more so the labels are current.
  useEffect(() => { if (open) { refresh(); readActive(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (kind: "videoinput" | "audioinput" | "audiooutput", deviceId: string) => {
    if (!room) return;
    try {
      await room.switchActiveDevice(kind, deviceId);
    } catch {
      // graceful — device may have disappeared between enumerate and click
      return;
    }
    try {
      const key =
        kind === "videoinput" ? "neoconf:device:videoId" :
        kind === "audioinput" ? "neoconf:device:audioId" :
        "neoconf:device:audioOutId";
      window.localStorage.setItem(key, deviceId);
    } catch {}
    if (kind === "videoinput") setActiveCam(deviceId);
    else if (kind === "audioinput") setActiveMic(deviceId);
    else setActiveOut(deviceId);
  };

  const labelFor = (d: MediaDeviceInfo, idx: number, prefix: string) =>
    (d.label && d.label.trim()) || `${prefix} ${idx + 1}`;

  const Section = ({
    title, items, active, kind, emptyHint,
  }: {
    title: string;
    items: MediaDeviceInfo[];
    active: string | null;
    kind: "videoinput" | "audioinput" | "audiooutput";
    emptyHint?: string;
  }) => (
    <div style={{ padding: "8px 4px" }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "rgba(255,255,255,0.55)", padding: "0 8px 4px" }}>{title}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", padding: "6px 8px" }}>{emptyHint || "No devices found"}</div>
      ) : (
        <ul role="listbox" aria-label={title} style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((d, i) => {
            const isActive = !!active && d.deviceId === active;
            const prefix = kind === "videoinput" ? "Camera" : kind === "audioinput" ? "Microphone" : "Speaker";
            return (
              <li key={d.deviceId || i} role="option" aria-selected={isActive}>
                <button
                  type="button"
                  onClick={() => pick(kind, d.deviceId)}
                  style={{
                    width: "100%", textAlign: "left", padding: "8px 10px",
                    background: isActive ? "rgba(34,211,238,0.15)" : "transparent",
                    border: "none", color: "#fff", fontSize: 13, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 8, borderRadius: 6,
                  }}
                >
                  <span style={{ width: 14, color: isActive ? "#22d3ee" : "transparent" }} aria-hidden="true">✓</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labelFor(d, i, prefix)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <div data-room-chrome="true" style={{ position: "relative" }}>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Audio & video devices"
        className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
      >
        Devices
      </button>
      {open && (
        <div
          ref={popRef}
          role="dialog"
          aria-label="Audio and video devices"
          style={{
            position: "absolute", top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
            width: 320, maxHeight: 420, overflowY: "auto",
            background: "rgba(17,17,24,0.98)", color: "#fff",
            border: "1px solid rgba(255,255,255,0.15)", borderRadius: 12,
            boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
            padding: 6, zIndex: 9999,
          }}
        >
          <Section title="Camera" items={cams} active={activeCam} kind="videoinput" />
          <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "2px 6px" }} />
          <Section title="Microphone" items={mics} active={activeMic} kind="audioinput" />
          <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "2px 6px" }} />
          {speakerSupported ? (
            <Section title="Speaker" items={outs} active={activeOut} kind="audiooutput" />
          ) : (
            <div style={{ padding: "8px 10px" }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "rgba(255,255,255,0.55)", padding: "0 0 4px" }}>Speaker</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>Your browser doesn’t support selecting an output device. Use your system audio settings instead.</div>
            </div>
          )}
          <AudioProcessingSection />
          <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "2px 6px" }} />
          <ShowStatsRow />
        </div>
      )}
    </div>
  );
}

/**
 * AudioProcessingSection
 *
 * Three switches controlling browser-level audio processing on the local
 * mic track: Noise suppression, Echo cancellation, Auto gain control.
 * These are standard WebRTC constraints honored by Chrome, Edge, Firefox,
 * and Safari (with varying DSP quality). Toggling republishes the mic
 * track via localParticipant.setMicrophoneEnabled() so the change takes
 * effect mid-call without leaving the room.
 *
 * Defaults match Zoom/Meet: all three ON. Preferences persist to
 * neoconf:audio:noiseSuppression / echoCancellation / autoGainControl
 * so the prejoin can read them on next join.
 */
function AudioProcessingSection() {
  const room = useRoomContext();
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();

  const readPref = (key: string, fallback: boolean): boolean => {
    try { const v = window.localStorage.getItem(key); return v == null ? fallback : v === "1"; } catch { return fallback; }
  };
  const writePref = (key: string, value: boolean) => {
    try { window.localStorage.setItem(key, value ? "1" : "0"); } catch {}
  };

  const [ns, setNs] = useState<boolean>(() => readPref("neoconf:audio:noiseSuppression", true));
  const [ec, setEc] = useState<boolean>(() => readPref("neoconf:audio:echoCancellation", true));
  const [agc, setAgc] = useState<boolean>(() => readPref("neoconf:audio:autoGainControl", true));
  const [busy, setBusy] = useState(false);

  // Feature-detect which constraints the browser claims to support.
  const supports = useMemo(() => {
    try {
      const s = navigator.mediaDevices.getSupportedConstraints?.() || {};
      return {
        noiseSuppression: s.noiseSuppression !== false,
        echoCancellation: s.echoCancellation !== false,
        autoGainControl: s.autoGainControl !== false,
      };
    } catch {
      return { noiseSuppression: true, echoCancellation: true, autoGainControl: true };
    }
  }, []);

  const applyConstraints = async (next: { ns: boolean; ec: boolean; agc: boolean }) => {
    if (!localParticipant || busy) return; if (!isMicrophoneEnabled) return; // don’t auto-unmute when toggling processing
    setBusy(true);
    try {
      let micDeviceId: string | undefined;
      try {
        const r: any = room;
        if (r && typeof r.getActiveDevice === "function") {
          micDeviceId = r.getActiveDevice("audioinput") || undefined;
        }
      } catch {}
      const captureOptions: any = {
        noiseSuppression: next.ns,
        echoCancellation: next.ec,
        autoGainControl: next.agc,
      };
      if (micDeviceId) captureOptions.deviceId = micDeviceId;
      // Republish the mic track with new constraints.
      await localParticipant.setMicrophoneEnabled(true, captureOptions);
    } catch {
      // ignore — if it fails the toggle simply doesn’t take effect
    } finally {
      setBusy(false);
    }
  };

  const toggleNs = () => { const v = !ns; setNs(v); writePref("neoconf:audio:noiseSuppression", v); applyConstraints({ ns: v, ec, agc }); };
  const toggleEc = () => { const v = !ec; setEc(v); writePref("neoconf:audio:echoCancellation", v); applyConstraints({ ns, ec: v, agc }); };
  const toggleAgc = () => { const v = !agc; setAgc(v); writePref("neoconf:audio:autoGainControl", v); applyConstraints({ ns, ec, agc: v }); };

  const Row = ({ label, hint, on, onToggle, disabled }: { label: string; hint: string; on: boolean; onToggle: () => void; disabled?: boolean }) => (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      disabled={disabled || busy}
      style={{
        width: "100%", textAlign: "left", padding: "8px 10px",
        background: "transparent", border: "none", color: "#fff",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex", alignItems: "center", gap: 10, borderRadius: 6,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <span style={{
        position: "relative", width: 32, height: 18, borderRadius: 999,
        background: on ? "rgba(34,211,238,0.85)" : "rgba(255,255,255,0.18)",
        transition: "background 120ms ease", flexShrink: 0,
        boxShadow: on ? "0 0 8px rgba(34,211,238,0.45)" : "none",
      }} aria-hidden="true">
        <span style={{
          position: "absolute", top: 2, left: on ? 16 : 2, width: 14, height: 14,
          borderRadius: "50%", background: "#fff", transition: "left 120ms ease",
        }} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 500 }}>{label}</span>
        <span style={{ display: "block", fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 1 }}>{hint}</span>
      </span>
    </button>
  );

  return (
    <div style={{ padding: "8px 4px" }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "rgba(255,255,255,0.55)", padding: "0 8px 4px" }}>Audio processing</div>
      <Row
        label="Noise suppression"
        hint="Filter background noise like keyboards and fans"
        on={ns}
        onToggle={toggleNs}
        disabled={!supports.noiseSuppression}
      />
      <Row
        label="Echo cancellation"
        hint="Prevent your speakers from echoing back to others"
        on={ec}
        onToggle={toggleEc}
        disabled={!supports.echoCancellation}
      />
      <Row
        label="Auto gain control"
        hint="Automatically level your mic volume"
        on={agc}
        onToggle={toggleAgc}
        disabled={!supports.autoGainControl}
      />
    </div>
  );
}

/**
 * ConnectionStatsOverlay
 *
 * World-class per-tile WebRTC stats chip. Polls each participant\u2019s
 * RTCStatsReport every 2s and renders a compact monospace chip in the
 * top-left corner of each LiveKit tile showing:
 *
 *   - Connection quality (colored dot from LiveKit ConnectionQuality)
 *   - Bitrate (kbps, computed as delta(bytes)*8/elapsed)
 *   - Packet loss (%, delta packets lost / delta packets received)
 *   - Round-trip time (ms, from candidate-pair currentRoundTripTime)
 *   - Video resolution and fps
 *
 * LiveKit\u2019s stock <VideoConference /> renders tiles internally, so we
 * use a MutationObserver to track [data-lk-participant-sid] elements and
 * attach an absolutely positioned chip inside each via React portals.
 *
 * Toggle is persisted to neoconf:ui:showStats and broadcast via the
 * neoconf:stats-toggle window event so the DeviceSwitcher footer can drive
 * it without prop drilling. All work is gated on enabled === true so the
 * polling loop and portal work disappear entirely when the user has stats off.
 */
function ConnectionStatsOverlay() {
  const participants = useParticipants();
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("neoconf:ui:showStats") === "1"; } catch { return false; }
  });
  useEffect(() => {
    const onToggle = (e: Event) => {
      const ce = e as CustomEvent<{ on: boolean }>;
      setEnabled(Boolean(ce.detail?.on));
    };
    window.addEventListener("neoconf:stats-toggle", onToggle as EventListener);
    return () => window.removeEventListener("neoconf:stats-toggle", onToggle as EventListener);
  }, []);
  const [tileMap, setTileMap] = useState<Map<string, HTMLElement>>(new Map());
  useEffect(() => {
    if (!enabled) { setTileMap(new Map()); return; }
    let raf = 0;
    const scan = () => {
      const nodes = document.querySelectorAll<HTMLElement>("[data-lk-participant-sid]");
      const next = new Map<string, HTMLElement>();
      nodes.forEach((n) => {
        const sid = n.getAttribute("data-lk-participant-sid");
        if (sid) next.set(sid, n);
      });
      setTileMap((prev) => {
        if (prev.size === next.size) {
          let same = true;
          for (const [k, v] of next) { if (prev.get(k) !== v) { same = false; break; } }
          if (same) return prev;
        }
        return next;
      });
    };
    scan();
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(scan);
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-lk-participant-sid"] });
    return () => { mo.disconnect(); cancelAnimationFrame(raf); };
  }, [enabled]);
  if (!enabled) return null;
  return (
    <>
      {participants.map((p) => {
        const host = tileMap.get(p.sid);
        if (!host) return null;
        return <StatsChip key={p.sid} participant={p} host={host} />;
      })}
    </>
  );
}

type StatsSample = {
  bitrateKbps: number;
  packetLossPct: number;
  rttMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
};

function qualityColor(q: unknown): string {
  // LiveKit ConnectionQuality is exported as a string enum
  switch (String(q)) {
    case "excellent": return "#22c55e";
    case "good": return "#eab308";
    case "poor": return "#ef4444";
    case "lost": return "#7f1d1d";
    default: return "#9ca3af";
  }
}

type StatLike = {
  type?: string;
  bytesSent?: number;
  bytesReceived?: number;
  packetsLost?: number;
  packetsReceived?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  currentRoundTripTime?: number;
  nominated?: boolean;
  state?: string;
};

function StatsChip({ participant, host }: { participant: Participant; host: HTMLElement }) {
  const [sample, setSample] = useState<StatsSample | null>(null);
  const [quality, setQuality] = useState<unknown>(participant.connectionQuality);
  const prevBytesRef = useRef<{ bytes: number; t: number } | null>(null);
  const prevLossRef = useRef<{ lost: number; recv: number } | null>(null);
  useEffect(() => {
    const onQ = () => setQuality(participant.connectionQuality);
    try { participant.on(RoomEvent.ConnectionQualityChanged as never, onQ as never); } catch {}
    return () => { try { participant.off(RoomEvent.ConnectionQualityChanged as never, onQ as never); } catch {} };
  }, [participant]);
  useEffect(() => {
    const cs = getComputedStyle(host);
    if (cs.position === "static") host.style.position = "relative";
  }, [host]);
  useEffect(() => {
    let cancelled = false;
    const collect = async () => {
      try {
        const pubs = Array.from(participant.trackPublications.values());
        const videoPub = pubs.find((pp) => pp.kind === Track.Kind.Video && pp.track);
        const audioPub = pubs.find((pp) => pp.kind === Track.Kind.Audio && pp.track);
        const pub = videoPub ?? audioPub;
        if (!pub || !pub.track) return;
        const anyTrack = pub.track as unknown as { sender?: RTCRtpSender; receiver?: RTCRtpReceiver };
        let report: RTCStatsReport | null = null;
        if (anyTrack.sender && typeof anyTrack.sender.getStats === "function") report = await anyTrack.sender.getStats();
        else if (anyTrack.receiver && typeof anyTrack.receiver.getStats === "function") report = await anyTrack.receiver.getStats();
        if (!report || cancelled) return;
        let bytes: number | null = null;
        let lost: number | null = null;
        let recv: number | null = null;
        let width: number | null = null;
        let height: number | null = null;
        let fps: number | null = null;
        let rttMs: number | null = null;
        report.forEach((raw) => {
          const stat = raw as StatLike;
          if (stat.type === "outbound-rtp" || stat.type === "inbound-rtp") {
            if (typeof stat.bytesSent === "number") bytes = (bytes ?? 0) + stat.bytesSent;
            if (typeof stat.bytesReceived === "number") bytes = (bytes ?? 0) + stat.bytesReceived;
            if (typeof stat.packetsLost === "number") lost = (lost ?? 0) + stat.packetsLost;
            if (typeof stat.packetsReceived === "number") recv = (recv ?? 0) + stat.packetsReceived;
            if (typeof stat.frameWidth === "number") width = stat.frameWidth;
            if (typeof stat.frameHeight === "number") height = stat.frameHeight;
            if (typeof stat.framesPerSecond === "number") fps = stat.framesPerSecond;
          }
          if (stat.type === "candidate-pair" && stat.nominated && stat.state === "succeeded") {
            if (typeof stat.currentRoundTripTime === "number") rttMs = Math.round(stat.currentRoundTripTime * 1000);
          }
        });
        const now = performance.now();
        let bitrateKbps = 0;
        if (bytes !== null) {
          const prev = prevBytesRef.current;
          if (prev) {
            const dt = (now - prev.t) / 1000;
            if (dt > 0) bitrateKbps = Math.max(0, Math.round(((bytes - prev.bytes) * 8) / 1000 / dt));
          }
          prevBytesRef.current = { bytes, t: now };
        }
        let packetLossPct = 0;
        if (lost !== null && recv !== null) {
          const prev = prevLossRef.current;
          if (prev) {
            const dLost = Math.max(0, lost - prev.lost);
            const dRecv = Math.max(1, recv - prev.recv);
            packetLossPct = Math.min(100, (dLost / dRecv) * 100);
          }
          prevLossRef.current = { lost, recv };
        }
        if (!cancelled) { setSample({ bitrateKbps, packetLossPct, rttMs, width, height, fps }); setQuality(participant.connectionQuality); }
      } catch { /* swallow per-tick errors */ }
    };
    collect();
    const id = window.setInterval(collect, 2000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [participant]);
  const color = qualityColor(quality);
  const chip = (
    <div
      style={{
        position: "absolute", top: 6, left: 6, zIndex: 5,
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "3px 6px", borderRadius: 6,
        background: "rgba(0,0,0,0.55)", color: "#fff",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 10, lineHeight: "12px", letterSpacing: 0.2,
        pointerEvents: "none", userSelect: "none",
        backdropFilter: "blur(4px)",
      }}
      aria-hidden="true"
      data-nc-stats-chip="true"
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 4px ${color}` }} />
      <span>
        {sample ? `${sample.bitrateKbps} kbps` : "\u2014 kbps"}
        {sample && sample.rttMs !== null ? ` \u00b7 ${sample.rttMs}ms` : ""}
        {sample && sample.packetLossPct > 0.1 ? ` \u00b7 ${sample.packetLossPct.toFixed(1)}%` : ""}
        {sample && sample.width && sample.height ? ` \u00b7 ${sample.width}\u00d7${sample.height}` : ""}
        {sample && sample.fps ? ` @ ${Math.round(sample.fps)}` : ""}
      </span>
    </div>
  );
  return createPortal(chip, host);
}
/**
 * ShowStatsRow
 *
 * A single-row pill switch in the DeviceSwitcher footer that toggles the
 * per-tile WebRTC stats overlay. Persists to neoconf:ui:showStats and
 * broadcasts neoconf:stats-toggle so ConnectionStatsOverlay reacts live.
 */
function ShowStatsRow() {
  const [on, setOn] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("neoconf:ui:showStats") === "1"; } catch { return false; }
  });
  const toggle = () => {
    const next = !on;
    setOn(next);
    try { localStorage.setItem("neoconf:ui:showStats", next ? "1" : "0"); } catch {}
    try { window.dispatchEvent(new CustomEvent("neoconf:stats-toggle", { detail: { on: next } })); } catch {}
  };
  return (
    <div style={{ padding: "8px 4px" }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "rgba(255,255,255,0.55)", padding: "0 8px 4px" }}>Diagnostics</div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={toggle}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", textAlign: "left",
          padding: "8px 10px", borderRadius: 8, border: "none",
          background: "transparent", color: "#fff", cursor: "pointer",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >
        <span style={{ display: "flex", flex: 1, minWidth: 0, flexDirection: "column" }}>
          <span style={{ fontSize: 13 }}>Show connection stats</span>
          <span style={{ display: "block", fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 1 }}>Bitrate, latency, packet loss, resolution</span>
        </span>
        <span
          aria-hidden="true"
          style={{
            width: 32, height: 18, borderRadius: 999,
            background: on ? "#22c55e" : "rgba(255,255,255,0.2)",
            position: "relative", transition: "background 120ms ease",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              position: "absolute", top: 2, left: on ? 16 : 2,
              width: 14, height: 14, borderRadius: "50%", background: "#fff",
              transition: "left 120ms ease",
            }}
          />
        </span>
      </button>
    </div>
  );
}