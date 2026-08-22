"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomContext, useLocalParticipant } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import { Play, Pause, RotateCcw, Plus, Minus, Timer as TimerIcon, Eye, EyeOff, Volume2, VolumeX } from "lucide-react";
import { computeRemaining, IDLE_TIMER, type TimerState, type TimerVisibility } from "@/lib/timer";

/**
 * MeetingTimer
 *
 * FRS §10. A single component that renders both the countdown display and,
 * for admins (host/moderator), the controls. State is server-authoritative
 * (see /api/events/[id]/timer) and clients keep it in sync two ways:
 *
 *   1. Fetch once on mount so late joiners see the current countdown.
 *   2. Listen for {type: "timer", state} data-channel packets sent by the
 *      admin's client after every successful control action, so everyone
 *      sees the same second without polling.
 *
 * Sound-on-expire is opt-in per client (localStorage key). Default off for
 * participants; default on for admins. The visual warning kicks in when
 * remaining <= max(30s, 10% of duration).
 */

const DATA_MSG_TYPE = "timer";
const SOUND_PREF_KEY = "neo:timer-sound";

function shouldWarn(remainingMs: number, durationMs: number): boolean {
  if (durationMs <= 0) return false;
  const threshold = Math.max(30_000, Math.floor(durationMs * 0.1));
  return remainingMs > 0 && remainingMs <= threshold;
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function beep() {
  try {
    const AC =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    osc.type = "sine";
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.3, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    osc.start(t);
    osc.stop(t + 0.6);
  } catch {
    // Some browsers block audio without a user gesture — fine, warning stays visual.
  }
}

export default function MeetingTimer({
  slug,
  roomRole,
}: {
  slug: string;
  roomRole?: string;
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const [state, setState] = useState<TimerState>(IDLE_TIMER);
  const [remaining, setRemaining] = useState<number>(0);
  const [err, setErr] = useState<string | null>(null);
  const [setMinutes, setSetMinutes] = useState<string>("5");
  const [soundEnabled, setSoundEnabled] = useState<boolean>(false);
  const prevRemainingRef = useRef<number>(0);

  const canManage = roomRole === "host" || roomRole === "cohost";
  const canSee = state.visibility === "everyone" || canManage;

  // Sound preference — admins default to on, participants default to off.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SOUND_PREF_KEY);
      if (stored === "on" || stored === "off") {
        setSoundEnabled(stored === "on");
      } else {
        setSoundEnabled(canManage);
      }
    } catch {
      setSoundEnabled(canManage);
    }
  }, [canManage]);

  const persistSoundPref = useCallback((next: boolean) => {
    setSoundEnabled(next);
    try {
      window.localStorage.setItem(SOUND_PREF_KEY, next ? "on" : "off");
    } catch {
      // ignore
    }
  }, []);

  // Fetch current state on mount + when slug changes.
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch(`/api/events/${encodeURIComponent(slug)}/timer`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        if (j.state) setState(j.state as TimerState);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Subscribe to broadcasts from other clients so state updates propagate.
  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as {
          type?: string;
          state?: TimerState;
        };
        if (msg?.type !== DATA_MSG_TYPE || !msg.state) return;
        setState(msg.state);
      } catch {
        // ignore non-JSON
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  // Local tick — recompute remaining every 200ms while running so the
  // display doesn't stutter but we're not doing 60fps updates for no gain.
  useEffect(() => {
    const tick = () => setRemaining(computeRemaining(state, Date.now()));
    tick();
    if (state.status !== "running") return;
    const iv = setInterval(tick, 200);
    return () => clearInterval(iv);
  }, [state]);

  // Beep on the second the timer expires. Only fire once per state edge.
  useEffect(() => {
    const prev = prevRemainingRef.current;
    prevRemainingRef.current = remaining;
    if (!soundEnabled) return;
    if (state.status !== "running") return;
    if (prev > 0 && remaining === 0) beep();
  }, [remaining, state.status, soundEnabled]);

  const broadcast = useCallback(
    (next: TimerState) => {
      try {
        const payload = new TextEncoder().encode(
          JSON.stringify({ type: DATA_MSG_TYPE, state: next }),
        );
        localParticipant?.publishData(payload, { reliable: true });
      } catch (e) {
        console.warn("[timer] broadcast failed", e);
      }
    },
    [localParticipant],
  );

  const call = useCallback(
    async (body: object) => {
      setErr(null);
      try {
        const res = await fetch(`/api/events/${encodeURIComponent(slug)}/timer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !(j as { state?: TimerState }).state) {
          setErr((j as { error?: string }).error || "timer_request_failed");
          return;
        }
        const next = (j as { state: TimerState }).state;
        setState(next);
        broadcast(next);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "timer_request_failed");
      }
    },
    [slug, broadcast],
  );

  // Nothing to render at all if the timer is idle and we're not an admin.
  if (!canSee) return null;
  if (!canManage && state.status === "idle" && state.durationMs === 0) return null;

  const warn = shouldWarn(remaining, state.durationMs);
  const expired = state.status === "running" && remaining === 0;
  const display = expired ? "00:00" : formatMs(remaining);

  return (
    <div
      data-room-chrome="true"
      style={{
        position: "fixed",
        top: 68,
        right: 20,
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px",
        borderRadius: 12,
        background: "rgba(11,16,32,0.9)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: `1px solid ${warn ? "rgba(244,63,94,0.55)" : "rgba(34,211,238,0.35)"}`,
        color: "#e5f8ff",
        boxShadow: `0 8px 24px rgba(0,0,0,0.4), 0 0 30px -12px ${warn ? "rgba(244,63,94,0.8)" : "rgba(34,211,238,0.5)"}`,
        pointerEvents: canManage ? "auto" : "none",
        minWidth: 160,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <TimerIcon size={14} aria-hidden style={{ opacity: 0.7 }} />
        <div
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: 0.5,
            color: warn ? "#fecaca" : "#cdeafd",
            lineHeight: 1,
          }}
        >
          {display}
        </div>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: "rgba(226,232,240,0.55)",
          }}
        >
          {state.status}
        </span>
      </div>

      {canManage && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(state.status === "idle" || state.status === "expired") && (
              <>
                <input
                  type="number"
                  min={1}
                  max={180}
                  value={setMinutes}
                  onChange={(e) => setSetMinutes(e.target.value)}
                  style={{
                    width: 54,
                    padding: "4px 6px",
                    fontSize: 12,
                    borderRadius: 6,
                    border: "1px solid rgba(148,163,184,0.35)",
                    background: "rgba(15,23,42,0.6)",
                    color: "#e2e8f0",
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const mins = Math.max(1, Math.min(180, parseInt(setMinutes, 10) || 0));
                    call({ action: "set", durationMs: mins * 60_000 });
                    call({ action: "start" });
                  }}
                  style={btnPrimary}
                >
                  <Play size={12} aria-hidden /> Start
                </button>
              </>
            )}
            {state.status === "running" && (
              <button type="button" onClick={() => call({ action: "pause" })} style={btnSecondary}>
                <Pause size={12} aria-hidden /> Pause
              </button>
            )}
            {state.status === "paused" && (
              <button type="button" onClick={() => call({ action: "resume" })} style={btnPrimary}>
                <Play size={12} aria-hidden /> Resume
              </button>
            )}
            {state.status !== "idle" && (
              <button type="button" onClick={() => call({ action: "reset" })} style={btnSecondary} title="Reset to full duration">
                <RotateCcw size={12} aria-hidden /> Reset
              </button>
            )}
          </div>
          {state.status !== "idle" && (
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" onClick={() => call({ action: "adjust", deltaMs: -60_000 })} style={btnGhost}>
                <Minus size={12} aria-hidden /> 1m
              </button>
              <button type="button" onClick={() => call({ action: "adjust", deltaMs: 60_000 })} style={btnGhost}>
                <Plus size={12} aria-hidden /> 1m
              </button>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              type="button"
              onClick={() =>
                call({
                  action: "visibility",
                  visibility: (state.visibility === "everyone" ? "admins" : "everyone") as TimerVisibility,
                })
              }
              style={btnGhost}
              title={state.visibility === "everyone" ? "Only admins can see the timer" : "Everyone can see the timer"}
            >
              {state.visibility === "everyone" ? <Eye size={12} aria-hidden /> : <EyeOff size={12} aria-hidden />}
              {state.visibility === "everyone" ? "Everyone" : "Admins only"}
            </button>
            <button
              type="button"
              onClick={() => persistSoundPref(!soundEnabled)}
              style={btnGhost}
              title="Toggle sound on this device when the timer expires"
            >
              {soundEnabled ? <Volume2 size={12} aria-hidden /> : <VolumeX size={12} aria-hidden />}
            </button>
          </div>
        </>
      )}

      {err && (
        <div style={{ fontSize: 10, color: "#fca5a5" }}>Error: {err}</div>
      )}
    </div>
  );
}

const btnBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 8px",
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 6,
  cursor: "pointer",
  border: "1px solid transparent",
  transition: "opacity 120ms",
};

const btnPrimary: React.CSSProperties = {
  ...btnBase,
  background: "rgba(34,211,238,0.2)",
  color: "#cdeafd",
  border: "1px solid rgba(34,211,238,0.55)",
};

const btnSecondary: React.CSSProperties = {
  ...btnBase,
  background: "rgba(255,255,255,0.06)",
  color: "#e5f8ff",
  border: "1px solid rgba(255,255,255,0.15)",
};

const btnGhost: React.CSSProperties = {
  ...btnBase,
  background: "transparent",
  color: "rgba(226,232,240,0.85)",
  border: "1px solid rgba(148,163,184,0.35)",
  padding: "3px 6px",
  fontSize: 10,
};
