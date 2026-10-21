"use client";

// /embed/zone — a partner website's zone meeting, inside the partner's page
// (public/widget/v1.js puts it in an iframe) or, after "Open in new tab",
// on its own (?tab=1).
//
// Nothing about the visitor is in the address. The partner's page hands
// over a one-time code by postMessage (src/lib/partners/protocol.ts); the
// server checks that the code was issued for the origin the browser says
// sent it, and trades it for a signed meeting session held in memory here.
// Joining returns a participant token for the zone's meeting. Who may frame
// this page is set per approved origin by the middleware (frame-ancestors).

import { Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import {
  LiveKitRoom,
  PreJoin,
  StartAudio,
  VideoConference,
  type LocalUserChoices,
} from "@livekit/components-react";
import { DisconnectReason, MediaDeviceFailure } from "livekit-client";
import "@livekit/components-styles";
import { ExternalLink, Maximize, MessageSquare, Minimize } from "lucide-react";
import LiveTranslation from "@/components/LiveTranslation";
import LiveCaptions from "@/components/LiveCaptions";
import CaptionsToggle from "@/components/CaptionsToggle";
import ApplyPrejoinChoices from "@/components/ApplyPrejoinChoices";
import ParticipantCountBadge from "@/components/ParticipantCountBadge";
import ChatPanel from "@/components/ChatPanel";
import { PrayerTimeSoFar, PrayerTimer } from "./PrayerTimer";
import { setEmbedSession } from "@/lib/partners/embedAuth";
import { PROTOCOL_VERSION, parseParentMessage, type EmbedEvent } from "@/lib/partners/protocol";
import { BRAND } from "@/lib/brand";

type Meeting = { title: string; zoneId: string };
type Participant = { name: string; verified: boolean };
type Live = { token: string; wsUrl: string; room: string };

type Phase =
  | { k: "handshake" }
  | { k: "redeeming" }
  | { k: "prejoin" }
  | { k: "joining" }
  | { k: "waiting"; reason: "waiting_room" | "wait_for_host" }
  | { k: "live"; live: Live }
  | { k: "left"; reason: "left" | "removed" | "replaced" | "disconnected" }
  | { k: "handed-off" }
  | { k: "ended" }
  | { k: "error"; code: string; message: string; retry: "session" | "join" | "none" };

/** How long the page waits for the partner's page to send a code. */
const HANDSHAKE_TIMEOUT_MS = 20_000;
/** Between join attempts while waiting for a host or in the waiting room. */
const POLL_MS = 5_000;

const TOOLBAR_BTN_CLASS =
  "inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-transparent px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/10 hover:border-white/25 active:scale-[0.98] transition";

class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    throw new ApiError("network", "Could not reach the meeting service. Check your connection.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & T;
  if (!res.ok) throw new ApiError(data.error?.code || `http_${res.status}`, data.error?.message || "Something went wrong. Try again.", res.status);
  return data;
}

export default function ZoneEmbedPage() {
  return (
    <Suspense fallback={<Screen theme="dark"><Spinner /></Screen>}>
      <ZoneEmbed />
    </Suspense>
  );
}

function ZoneEmbed() {
  const params = useSearchParams();
  const tabMode = params.get("tab") === "1";
  const theme = params.get("theme") === "light" ? "light" : "dark";

  const [phase, setPhase] = useState<Phase>({ k: "handshake" });
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [participant, setParticipant] = useState<Participant | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const sessionRef = useRef<string | null>(null);
  /** Where events go: the origin the code was redeemed for. Null until then (and always in a tab). */
  const parentOriginRef = useRef<string | null>(null);
  /**
   * The origin the browser reported for the parent's last code, before the
   * server has accepted it: where a refusal is reported (it carries no
   * credentials). Commands are still taken only from parentOriginRef.
   */
  const senderOriginRef = useRef<string | null>(null);
  const choicesRef = useRef<LocalUserChoices | null>(null);
  /** Join as soon as a session arrives (a parent's join(), or a rejoin after the session expired). */
  const wantJoinRef = useRef(false);
  /** Bumped to cancel a join or poll in flight. */
  const attemptRef = useRef(0);
  /** Why we are about to disconnect, when it is us. */
  const leavingRef = useRef<"left" | "handed-off" | null>(null);
  /** Devices already reported blocked: the prejoin asks again for each preview, the parent hears it once. */
  const deniedRef = useRef(new Set<string>());
  /** Whether this call ever connected: a call that never did is a connection error, not a departure. */
  const connectedRef = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // The visitor can still be "in" the meeting for the server after the
  // page goes: nothing to do, LiveKit drops the connection.

  const emit = useCallback(
    (ev: EmbedEvent) => {
      if (tabMode || typeof window === "undefined" || window.parent === window) return;
      const msg = { nlm: PROTOCOL_VERSION, ...ev };
      if (ev.type === "request-session") {
        // Carries nothing; the only message sent before we know the parent.
        window.parent.postMessage(msg, "*");
        return;
      }
      if (ev.type === "permission-denied") {
        if (deniedRef.current.has(ev.device)) return;
        deniedRef.current.add(ev.device);
      }
      const origin = parentOriginRef.current ?? (ev.type === "error" ? senderOriginRef.current : null);
      if (origin) window.parent.postMessage(msg, origin);
    },
    [tabMode],
  );

  const fail = useCallback(
    (e: unknown, retry: "session" | "join" | "none" = "join") => {
      const code = e instanceof ApiError ? e.code : "error";
      const message = e instanceof Error ? e.message : "Something went wrong. Try again.";
      setPhase({ k: "error", code, message, retry });
      emit({ type: "error", code, message });
    },
    [emit],
  );

  /** Ask for a (new) code: from the partner's page, or from the tab that opened this one. */
  const requestSession = useCallback(() => {
    setEmbedSession(null);
    sessionRef.current = null;
    setPhase({ k: "handshake" });
    if (tabMode) {
      if (window.opener) window.opener.postMessage({ nlm: PROTOCOL_VERSION, type: "request-session" }, window.location.origin);
      return;
    }
    emit({ type: "request-session" });
  }, [emit, tabMode]);

  const join = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      wantJoinRef.current = true;
      requestSession();
      return;
    }
    wantJoinRef.current = false;
    const attempt = ++attemptRef.current;
    setPhase({ k: "joining" });
    let lastReason: string | null = null;
    for (;;) {
      try {
        const r = await post<
          | { status: "ready"; token: string; wsUrl: string; room: string }
          | { status: "waiting_room" | "wait_for_host" | "denied" }
        >("/api/partner/embed/join", { session });
        if (attempt !== attemptRef.current) return;
        if (r.status === "ready") {
          leavingRef.current = null;
          connectedRef.current = false;
          setPhase({ k: "live", live: { token: r.token, wsUrl: r.wsUrl, room: r.room } });
          return;
        }
        if (r.status === "denied") {
          const message = "The host did not let you in.";
          setPhase({ k: "error", code: "denied", message, retry: "none" });
          emit({ type: "error", code: "denied", message });
          return;
        }
        if (r.status !== lastReason) {
          lastReason = r.status;
          setPhase({ k: "waiting", reason: r.status });
          emit({ type: "waiting", reason: r.status });
        }
      } catch (e) {
        if (attempt !== attemptRef.current) return;
        if (e instanceof ApiError && (e.code === "session_expired" || e.code === "invalid_session") && !tabMode) {
          wantJoinRef.current = true;
          requestSession();
          return;
        }
        if (e instanceof ApiError && e.code === "meeting_ended") {
          setPhase({ k: "ended" });
          emit({ type: "meeting-ended" });
          return;
        }
        if (e instanceof ApiError && e.code === "rate_limited" && lastReason) {
          // Keep waiting; the next poll gets through.
        } else {
          fail(e, e instanceof ApiError && e.code === "zone_moved" ? "session" : "join");
          return;
        }
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (attempt !== attemptRef.current) return;
    }
  }, [emit, fail, requestSession, tabMode]);

  const redeem = useCallback(
    async (code: string, parentOrigin: string) => {
      setPhase({ k: "redeeming" });
      try {
        const r = await post<{ session: string; meeting: Meeting; participant: Participant }>("/api/partner/embed/redeem", {
          code,
          parentOrigin,
        });
        sessionRef.current = r.session;
        setEmbedSession(r.session);
        if (parentOrigin !== "self") parentOriginRef.current = parentOrigin;
        setMeeting(r.meeting);
        setParticipant(r.participant);
        emit({ type: "ready", meeting: r.meeting, participant: r.participant });
        if (wantJoinRef.current || tabMode) void join();
        else setPhase({ k: "prejoin" });
      } catch (e) {
        fail(e, "session");
      }
    },
    [emit, fail, join, tabMode],
  );

  /** Leave on our own initiative (the parent's leave(), or Leave in the toolbar is LiveKit's). */
  const leave = useCallback(() => {
    attemptRef.current++;
    const p = phaseRef.current;
    // LiveKitRoom unmounts and disconnects; if that reports a disconnect, it is ours.
    if (p.k === "live") leavingRef.current = "left";
    if (p.k === "live" || p.k === "waiting" || p.k === "joining") {
      setPhase({ k: "left", reason: "left" });
      emit({ type: "left", reason: "left" });
    }
  }, [emit]);

  // Messages from the partner's page (or, in a tab, from the tab that opened us).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = parseParentMessage(event.data);
      if (!msg) return;
      if (tabMode) {
        if (event.source !== window.opener || event.origin !== window.location.origin) return;
        if (msg.type === "session") void redeem(msg.code, "self");
        return;
      }
      if (event.source !== window.parent || window.parent === window) return;
      if (msg.type === "session") {
        // The origin is the browser's word for who sent it; the server
        // accepts the code only for the origin it was issued for.
        senderOriginRef.current = event.origin;
        void redeem(msg.code, event.origin);
        return;
      }
      // Commands only from the page the code was redeemed for.
      if (event.origin !== parentOriginRef.current) return;
      if (msg.type === "join") {
        const p = phaseRef.current.k;
        if (p === "prejoin" || p === "left" || p === "handshake") void join();
      } else if (msg.type === "leave") {
        leave();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [join, leave, redeem, tabMode]);

  // Ask for the first code, and give up if none comes.
  useEffect(() => {
    if (!tabMode && window.parent === window) {
      setPhase({
        k: "error",
        code: "not_embedded",
        message: "This meeting opens from the website it belongs to. Go back there to join.",
        retry: "none",
      });
      return;
    }
    if (tabMode && !window.opener) {
      setPhase({ k: "error", code: "no_opener", message: "Open this meeting again from the page it was on.", retry: "none" });
      return;
    }
    requestSession();
  }, [requestSession, tabMode]);

  useEffect(() => {
    if (phase.k !== "handshake") return;
    const t = window.setTimeout(() => {
      if (phaseRef.current.k !== "handshake") return;
      const message = tabMode
        ? "The meeting could not be moved to this tab. Open it again from the page it was on."
        : "The website did not start the meeting. Reload the page to try again.";
      setPhase({ k: "error", code: "no_session", message, retry: tabMode ? "none" : "session" });
      emit({ type: "error", code: "no_session", message });
    }, HANDSHAKE_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [phase.k, emit, tabMode]);

  useEffect(() => () => setEmbedSession(null), []);

  // ---- open in a new tab ---------------------------------------------------
  const childRef = useRef<Window | null>(null);
  const handoffCodeRef = useRef<string | null>(null);
  const childAskedRef = useRef(false);

  const giveChildTheCode = useCallback(() => {
    const child = childRef.current;
    const code = handoffCodeRef.current;
    if (!child || !code || !childAskedRef.current) return;
    child.postMessage({ nlm: PROTOCOL_VERSION, type: "session", code }, window.location.origin);
    handoffCodeRef.current = null;
    childRef.current = null;
    // The same person joins there; leave here so they are not in twice.
    attemptRef.current++;
    leavingRef.current = "handed-off";
    setPhase({ k: "handed-off" });
    emit({ type: "left", reason: "opened_in_tab" });
  }, [emit]);

  useEffect(() => {
    const onChild = (event: MessageEvent) => {
      if (!childRef.current || event.source !== childRef.current || event.origin !== window.location.origin) return;
      const d = event.data as { nlm?: unknown; type?: unknown } | null;
      if (d?.nlm !== PROTOCOL_VERSION || d.type !== "request-session") return;
      childAskedRef.current = true;
      giveChildTheCode();
    };
    window.addEventListener("message", onChild);
    return () => window.removeEventListener("message", onChild);
  }, [giveChildTheCode]);

  const openInTab = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    // Opened inside the click, or a pop-up blocker stops it; the code follows.
    const url = new URL("/embed/zone", window.location.origin);
    url.searchParams.set("tab", "1");
    if (theme === "light") url.searchParams.set("theme", "light");
    const child = window.open(url.toString(), "_blank");
    if (!child) {
      setNotice("Your browser blocked the new tab. Allow pop-ups for this site and try again.");
      return;
    }
    childRef.current = child;
    childAskedRef.current = false;
    try {
      const r = await post<{ code: string }>("/api/partner/embed/handoff", { session });
      handoffCodeRef.current = r.code;
      giveChildTheCode();
    } catch (e) {
      childRef.current = null;
      try {
        child.close();
      } catch {
        /* already gone */
      }
      setNotice(e instanceof Error ? e.message : "Could not open a new tab.");
    }
  }, [giveChildTheCode, theme]);

  const [showChat, setShowChat] = useState(false);
  const getSession = useCallback(() => sessionRef.current, []);
  // The partner's page hears the visitor's prayer time each second while it counts.
  const onPrayerTick = useCallback(
    (seconds: number, connected: boolean, sessionId: string | null) => emit({ type: "prayer-time", seconds, connected, sessionId }),
    [emit],
  );

  // ---- fullscreen ------------------------------------------------------------
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const on = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setNotice("Full screen is not available here.");
    }
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // ---- in the meeting ------------------------------------------------------
  const onDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      const ours = leavingRef.current;
      leavingRef.current = null;
      // Our own leave or hand-off: already shown and reported.
      if (ours) return;
      if (!connectedRef.current) {
        fail(new ApiError("connect_failed", "Could not connect to the meeting. Check your connection and try again.", 0));
        return;
      }
      if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED) {
        setPhase({ k: "ended" });
        emit({ type: "meeting-ended" });
        return;
      }
      const why =
        reason === DisconnectReason.CLIENT_INITIATED
          ? "left"
          : reason === DisconnectReason.PARTICIPANT_REMOVED
            ? "removed"
            : reason === DisconnectReason.DUPLICATE_IDENTITY
              ? "replaced"
              : "disconnected";
      setPhase({ k: "left", reason: why });
      emit({ type: "left", reason: why });
    },
    [emit, fail],
  );

  const onDeviceFailure = useCallback(
    (failure?: MediaDeviceFailure, kind?: MediaDeviceKind) => {
      if (failure !== MediaDeviceFailure.PermissionDenied) return;
      const device = kind === "videoinput" ? "camera" : kind === "audioinput" ? "microphone" : "media";
      emit({ type: "permission-denied", device });
      setNotice(
        device === "camera"
          ? "Your camera is blocked. Allow it in the browser's address bar to be seen."
          : "Your microphone is blocked. Allow it in the browser's address bar to be heard.",
      );
    },
    [emit],
  );

  // ---- screens -------------------------------------------------------------
  const title = meeting?.title || "Meeting";
  // Above LiveKit's control bar in the meeting; at the top elsewhere, clear of the Join button.
  const toast = notice ? (
    <div
      role="status"
      style={{
        position: "absolute",
        ...(phase.k === "live" ? { bottom: 88 } : { top: 12 }),
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 70,
        width: "max-content",
        maxWidth: "calc(100% - 32px)",
      }}
      className="rounded-lg bg-black/80 px-3 py-2 text-center text-xs text-white shadow-lg"
    >
      {notice}
    </div>
  ) : null;

  if (phase.k === "live") {
    const choices = choicesRef.current;
    return (
      <div data-lk-theme="default" className="room-shell nlm-zone-embed" style={fill}>
        <EmbedStyles />
        <LiveKitRoom
          serverUrl={phase.live.wsUrl}
          token={phase.live.token}
          connect
          audio={choices ? (choices.audioEnabled ? (choices.audioDeviceId ? { deviceId: { ideal: choices.audioDeviceId } } : true) : false) : true}
          video={choices ? (choices.videoEnabled ? (choices.videoDeviceId ? { deviceId: { ideal: choices.videoDeviceId } } : true) : false) : true}
          onConnected={() => {
            connectedRef.current = true;
            emit({ type: "joined" });
          }}
          onDisconnected={onDisconnected}
          onMediaDeviceFailure={onDeviceFailure}
          style={{ height: "100%" }}
        >
          <ApplyPrejoinChoices choices={choices} />
          <div style={{ position: "absolute", top: 64, left: "50%", transform: "translateX(-50%)", zIndex: 60 }}>
            <StartAudio label="Tap to turn on sound" />
          </div>
          <div
            data-room-chrome="true"
            className="room-toolbar"
            style={{
              position: "absolute",
              top: 8,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 12,
              display: "flex",
              flexWrap: "nowrap",
              alignItems: "center",
              gap: 6,
              padding: "6px 8px",
              borderRadius: 12,
              background: "rgba(11,16,32,0.75)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: "0 4px 20px rgba(0,0,0,0.45)",
              maxWidth: "calc(100% - 24px)",
            }}
          >
            <span className="hidden max-w-[16rem] truncate px-1 text-xs font-medium text-neutral-200 sm:inline" title={title}>
              {title}
            </span>
            <ParticipantCountBadge />
            <LiveTranslation />
            <button type="button" data-room-chrome="true" onClick={() => setShowChat((v) => !v)} className={TOOLBAR_BTN_CLASS} title="Chat">
              <MessageSquare size={16} aria-hidden />
              <span className="hidden sm:inline">Chat</span>
            </button>
            <button type="button" data-room-chrome="true" onClick={toggleFullscreen} className={TOOLBAR_BTN_CLASS} title="Full screen">
              {isFullscreen ? <Minimize size={16} aria-hidden /> : <Maximize size={16} aria-hidden />}
              <span className="hidden sm:inline">{isFullscreen ? "Exit full screen" : "Full screen"}</span>
            </button>
            {!tabMode && (
              <button type="button" data-room-chrome="true" onClick={openInTab} className={TOOLBAR_BTN_CLASS} title="Open in a new tab">
                <ExternalLink size={16} aria-hidden />
                <span className="hidden sm:inline">New tab</span>
              </button>
            )}
          </div>
          <VideoConference />
          <PrayerTimer getSession={getSession} onTick={onPrayerTick} />
          <LiveCaptions />
          <CaptionsToggle roomRole="attendee" roomName={phase.live.room} eventSlug={phase.live.room} />
          <ChatPanel eventId={phase.live.room} open={showChat} onClose={() => setShowChat(false)} canAttach={false} />
          {toast}
        </LiveKitRoom>
      </div>
    );
  }

  let body: ReactNode;
  switch (phase.k) {
    case "handshake":
    case "redeeming":
    case "joining":
      body = (
        <>
          <Spinner />
          <p className="mt-4 text-sm opacity-70">{phase.k === "joining" ? "Joining…" : "Opening the meeting…"}</p>
        </>
      );
      break;
    case "prejoin":
      body = (
        <div className="w-full max-w-xl">
          <h1 className="text-center text-lg font-semibold">{title}</h1>
          <p className="mt-1 text-center text-sm opacity-75">
            Joining as <strong>{participant?.name}</strong>
            {participant && !participant.verified && <span className="ml-1.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-300">guest</span>}
          </p>
          <div data-lk-theme="default" className="nlm-prejoin mt-4">
            <PreJoin
              defaults={{ username: participant?.name || "", videoEnabled: true, audioEnabled: true }}
              onValidate={() => true}
              onSubmit={(values) => {
                choicesRef.current = values;
                void join();
              }}
              onError={(e) => {
                if (e.name === "NotAllowedError") {
                  emit({ type: "permission-denied", device: "media" });
                  setNotice("Camera or microphone blocked. You can still join, or allow them in the browser's address bar.");
                }
              }}
              joinLabel="Join meeting"
              micLabel="Microphone"
              camLabel="Camera"
            />
          </div>
        </div>
      );
      break;
    case "waiting":
      body = (
        <>
          <Spinner />
          <h1 className="mt-4 text-lg font-semibold">{title}</h1>
          <p className="mt-1 text-sm opacity-75">
            {phase.reason === "waiting_room" ? "Waiting for the host to let you in…" : "Waiting for the host to start the meeting…"}
          </p>
          <button type="button" onClick={leave} className={secondaryBtn}>
            Cancel
          </button>
        </>
      );
      break;
    case "left":
      body = (
        <>
          <h1 className="text-lg font-semibold">
            {phase.reason === "removed"
              ? "You were removed from the meeting"
              : phase.reason === "replaced"
                ? "You joined from another window"
                : phase.reason === "disconnected"
                  ? "You were disconnected"
                  : "You left the meeting"}
          </h1>
          <p className="mt-1 text-sm opacity-75">{title}</p>
          <PrayerTimeSoFar session={sessionRef.current} />
          {phase.reason !== "removed" && (
            <button type="button" onClick={() => void join()} className={primaryBtn}>
              Rejoin
            </button>
          )}
        </>
      );
      break;
    case "handed-off":
      body = (
        <>
          <h1 className="text-lg font-semibold">Opened in a new tab</h1>
          <p className="mt-1 text-sm opacity-75">The meeting continues in the other tab.</p>
          <button type="button" onClick={() => void join()} className={secondaryBtn}>
            Join here instead
          </button>
        </>
      );
      break;
    case "ended":
      body = (
        <>
          <h1 className="text-lg font-semibold">The meeting has ended</h1>
          <p className="mt-1 text-sm opacity-75">{title}</p>
          <PrayerTimeSoFar session={sessionRef.current} />
          <button type="button" onClick={() => void join()} className={secondaryBtn}>
            Join again
          </button>
        </>
      );
      break;
    case "error":
      body = (
        <>
          <h1 className="text-lg font-semibold">Can’t open the meeting</h1>
          <p className="mx-auto mt-1 max-w-sm text-sm opacity-75">{phase.message}</p>
          {phase.retry !== "none" && (
            <button type="button" onClick={() => (phase.retry === "session" ? requestSession() : void join())} className={primaryBtn}>
              Try again
            </button>
          )}
        </>
      );
      break;
  }

  return (
    <Screen theme={theme}>
      <EmbedStyles />
      {body}
      {toast}
      <p className="absolute bottom-3 left-0 right-0 text-center text-[11px] opacity-40">{BRAND.name}</p>
    </Screen>
  );
}

const fill: CSSProperties = { position: "fixed", inset: 0, zIndex: 2147483000, background: "#03050a" };
const primaryBtn = "mt-5 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400";
const secondaryBtn = "mt-5 rounded-lg border border-current/30 px-4 py-2 text-sm opacity-80 hover:opacity-100";

function Screen({ theme, children }: { theme: "dark" | "light"; children: ReactNode }) {
  const dark = theme === "dark";
  return (
    <div
      style={{ ...fill, background: dark ? "#03050a" : "#f8fafc", color: dark ? "#e2e8f0" : "#0f172a", overflow: "auto" }}
      className="flex flex-col items-center justify-center p-4 text-center"
    >
      {children}
    </div>
  );
}

function Spinner() {
  return <div aria-label="Loading" className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" />;
}

/** The prejoin's name box (the name comes from the partner) and LiveKit's own chat are hidden: the meeting's chat is ChatPanel, which the room uses too. */
function EmbedStyles() {
  return (
    <style>{`
      .nlm-prejoin .lk-prejoin { margin: 0 auto; }
      .nlm-prejoin #username { display: none; }
      .nlm-zone-embed .lk-chat-toggle { display: none; }
      .nlm-zone-embed .lk-video-conference { height: 100%; }
    `}</style>
  );
}
