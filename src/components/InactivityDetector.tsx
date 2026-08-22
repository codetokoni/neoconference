"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, type Participant, type TrackPublication } from "livekit-client";

/**
 * InactivityDetector
 *
 * FRS §11. Detects prolonged inactivity across the union of signals the spec
 * lists — mouse/keyboard/touch input, chat/reaction/poll data-channel
 * traffic, mic or camera publication toggles — and prompts the user with
 * "Are you still in the meeting?" after a threshold. Ignoring the prompt
 * closes it silently (attendance-report integration lives on the beacon
 * route and is a follow-up); the user pressing "I'm Still Here" resets the
 * idle timer.
 *
 * Non-inactivity indicators explicitly ignored:
 *   - camera and mic being *off*. The spec calls that out — a listener with
 *     camera and mic off is still an attentive participant. Only *changes*
 *     (a mute/unmute or camera toggle) count as activity.
 *
 * Configuration is currently global. Per-event overrides (warning delay,
 * response window, admin exemption toggle) can be threaded through when
 * the dashboard needs them; the defaults below match what the spec text
 * offers as reasonable ("configurable period" of a few minutes).
 *
 * FRS §11 also asks that admins be exempt — done via the roomRole prop.
 */

const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1000;   // 5 minutes -> show prompt
const DEFAULT_RESPONSE_WINDOW_MS = 60 * 1000;      // 60 seconds to respond
const POLL_INTERVAL_MS = 15 * 1000;                // recheck every 15s

export interface InactivityConfig {
  enabled?: boolean;
  warningMs?: number;
  responseMs?: number;
  autoRemove?: boolean;
  exemptAdmins?: boolean;
}

const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  "mousemove",
  "mousedown",
  "keydown",
  "touchstart",
  "scroll",
  "wheel",
  "focus",
  "visibilitychange",
];

export default function InactivityDetector({
  roomRole,
  eventSlug,
  config,
}: {
  roomRole?: string;
  /** Optional — when provided the timeout also fires an "inactive" attendance
   *  beacon so the report captures the timeout event (FRS §11). Silent
   *  degrade when omitted: modal still works, nothing is persisted. */
  eventSlug?: string;
  /** FRS §11 per-event configuration. Any field left undefined falls through
   *  to the module-level defaults so older events keep their existing UX. */
  config?: InactivityConfig | null;
}) {
  const room = useRoomContext();
  const resolved = useMemo(() => ({
    enabled: config?.enabled ?? true,
    warningMs: config?.warningMs ?? DEFAULT_IDLE_THRESHOLD_MS,
    responseMs: config?.responseMs ?? DEFAULT_RESPONSE_WINDOW_MS,
    autoRemove: config?.autoRemove ?? false,
    exemptAdmins: config?.exemptAdmins ?? true,
  }), [config]);

  const [promptOpen, setPromptOpen] = useState(false);
  const [responseCountdown, setResponseCountdown] = useState<number>(
    Math.floor(resolved.responseMs / 1000),
  );
  const lastActivityRef = useRef<number>(Date.now());
  const responseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const adminExempt = resolved.exemptAdmins && (roomRole === "host" || roomRole === "cohost");
  const isExempt = !resolved.enabled || adminExempt;

  const markActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    if (promptOpen) {
      // Any activity while the prompt is open counts as a response.
      dismissPrompt();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptOpen]);

  const dismissPrompt = useCallback(() => {
    setPromptOpen(false);
    if (responseTimerRef.current) {
      clearInterval(responseTimerRef.current);
      responseTimerRef.current = null;
    }
    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
      dismissTimeoutRef.current = null;
    }
    setResponseCountdown(Math.floor(resolved.responseMs / 1000));
    lastActivityRef.current = Date.now();
  }, [resolved.responseMs]);

  // Wire global DOM activity listeners.
  useEffect(() => {
    if (isExempt) return;
    const onActivity = () => markActivity();
    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, onActivity, { passive: true });
    }
    return () => {
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, onActivity);
      }
    };
  }, [isExempt, markActivity]);

  // Wire LiveKit signals: data-channel messages the local user sends (chat,
  // reactions, poll responses, raise-hand) are all activity. So is a
  // mic/camera track publication or unmute — but *not* the initial published
  // state. We hook TrackPublished / TrackUnmuted for the local participant.
  useEffect(() => {
    if (isExempt || !room) return;
    const local = room.localParticipant;
    if (!local) return;
    const localIdentity = local.identity;

    const onData = (_payload: Uint8Array, participant?: Participant) => {
      if (participant?.identity === localIdentity) markActivity();
    };
    const onTrackChange = (_pub: TrackPublication, participant: Participant) => {
      if (participant.identity === localIdentity) markActivity();
    };

    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.TrackPublished, onTrackChange);
    room.on(RoomEvent.TrackUnpublished, onTrackChange);
    room.on(RoomEvent.TrackMuted, onTrackChange);
    room.on(RoomEvent.TrackUnmuted, onTrackChange);

    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.TrackPublished, onTrackChange);
      room.off(RoomEvent.TrackUnpublished, onTrackChange);
      room.off(RoomEvent.TrackMuted, onTrackChange);
      room.off(RoomEvent.TrackUnmuted, onTrackChange);
    };
  }, [isExempt, room, markActivity]);

  // Idle poll loop.
  useEffect(() => {
    if (isExempt) return;
    const iv = setInterval(() => {
      if (promptOpen) return; // already prompting
      const idle = Date.now() - lastActivityRef.current;
      if (idle >= resolved.warningMs) {
        setPromptOpen(true);
        setResponseCountdown(Math.floor(resolved.responseMs / 1000));

        // Start the response countdown.
        const startedAt = Date.now();
        responseTimerRef.current = setInterval(() => {
          const remaining = Math.max(
            0,
            resolved.responseMs - (Date.now() - startedAt),
          );
          setResponseCountdown(Math.ceil(remaining / 1000));
        }, 500);
        dismissTimeoutRef.current = setTimeout(() => {
          // No response — record it in the attendance journal so the report
          // reflects the timeout (FRS §11), then quietly dismiss OR (when
          // configured) disconnect the participant from the LiveKit room so
          // the "Auto-remove" setting actually removes them.
          if (eventSlug) {
            fetch("/api/attendance/beacon", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ slug: eventSlug, action: "inactive" }),
              keepalive: true,
            }).catch(() => {});
          }
          if (resolved.autoRemove && room) {
            // onDisconnected in page.tsx handles the redirect away from the
            // room — we just tear down the LiveKit session.
            try {
              room.disconnect();
            } catch {
              // fall through to the dismiss below; better than being stuck
            }
          }
          dismissPrompt();
        }, resolved.responseMs);
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [isExempt, promptOpen, dismissPrompt, eventSlug, resolved.warningMs, resolved.responseMs, resolved.autoRemove, room]);

  useEffect(() => {
    return () => {
      if (responseTimerRef.current) clearInterval(responseTimerRef.current);
      if (dismissTimeoutRef.current) clearTimeout(dismissTimeoutRef.current);
    };
  }, []);

  if (isExempt || !promptOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="inactivity-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          maxWidth: 380,
          width: "100%",
          padding: "28px 24px",
          borderRadius: 20,
          background: "rgba(11,16,32,0.95)",
          border: "1px solid rgba(34,211,238,0.35)",
          boxShadow: "0 20px 40px rgba(0,0,0,0.5), 0 0 60px -20px rgba(34,211,238,0.45)",
          textAlign: "center",
          color: "#e5f8ff",
        }}
      >
        <h2
          id="inactivity-title"
          style={{ fontSize: 18, fontWeight: 700, margin: 0, marginBottom: 8 }}
        >
          Are you still in the meeting?
        </h2>
        <p style={{ fontSize: 13, color: "rgba(226,232,240,0.75)", margin: 0, marginBottom: 20 }}>
          Press the button below to stay connected. Otherwise this notice will disappear on its own.
        </p>
        <div
          style={{
            fontSize: 40,
            fontWeight: 700,
            fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
            color: "#22d3ee",
            marginBottom: 20,
          }}
          aria-live="polite"
        >
          {responseCountdown}
        </div>
        <button
          type="button"
          onClick={dismissPrompt}
          autoFocus
          style={{
            width: "100%",
            padding: "12px 20px",
            fontSize: 14,
            fontWeight: 700,
            borderRadius: 12,
            border: "1px solid rgba(34,211,238,0.55)",
            background: "linear-gradient(180deg, rgba(34,211,238,0.35), rgba(34,211,238,0.15))",
            color: "#e5f8ff",
            cursor: "pointer",
          }}
        >
          I&apos;m Still Here
        </button>
      </div>
    </div>
  );
}
