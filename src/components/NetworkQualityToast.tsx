"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalParticipant } from "@livekit/components-react";
import { ConnectionQuality, ParticipantEvent, Track } from "livekit-client";

/**
 * NetworkQualityToast
 *
 * Watches the local participant's connectionQuality and surfaces a corner
 * toast for sustained Poor or Lost states, with an optional one-click
 * "Turn off camera" mitigation when the user is currently publishing video.
 *
 * Design notes:
 * - Debounced 3000ms before showing (avoid flapping on brief dips)
 * - Auto-dismisses 5000ms after quality recovers
 * - Manual dismiss persists for the rest of the session per quality state
 *   (re-arms when quality recovers and degrades again)
 * - prefers-reduced-motion → skip slide-in animation
 * - role/aria-live polite for Poor, assertive for Lost
 */

type Severity = "poor" | "lost" | null;

const DEBOUNCE_MS = 3000;
const AUTO_DISMISS_MS = 5000;
const SESSION_KEY = "neo:nqt-dismissed";

function describe(sev: Severity): { title: string; subtitle: string } {
  if (sev === "lost") {
    return {
      title: "Connection lost",
      subtitle: "Reconnecting\u2026",
    };
  }
  if (sev === "poor") {
    return {
      title: "Your connection is unstable",
      subtitle: "Audio and video quality may be degraded.",
    };
  }
  return { title: "", subtitle: "" };
}

function severityFromQuality(q: ConnectionQuality): Severity {
  if (q === ConnectionQuality.Lost) return "lost";
  if (q === ConnectionQuality.Poor) return "poor";
  return null;
}

export default function NetworkQualityToast() {
  const { localParticipant } = useLocalParticipant();
  const [severity, setSeverity] = useState<Severity>(null);
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastShownSevRef = useRef<Severity>(null);

  // prefers-reduced-motion
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(m.matches);
    sync();
    m.addEventListener?.("change", sync);
    return () => m.removeEventListener?.("change", sync);
  }, []);

  // Camera publication tracking
  useEffect(() => {
    if (!localParticipant) return;
    const sync = () => {
      const pub = localParticipant.getTrackPublication(Track.Source.Camera);
      setCameraOn(Boolean(pub && !pub.isMuted));
    };
    sync();
    const onChange = () => sync();
    localParticipant.on(ParticipantEvent.TrackMuted, onChange);
    localParticipant.on(ParticipantEvent.TrackUnmuted, onChange);
    localParticipant.on(ParticipantEvent.TrackPublished, onChange);
    localParticipant.on(ParticipantEvent.TrackUnpublished, onChange);
    return () => {
      localParticipant.off(ParticipantEvent.TrackMuted, onChange);
      localParticipant.off(ParticipantEvent.TrackUnmuted, onChange);
      localParticipant.off(ParticipantEvent.TrackPublished, onChange);
      localParticipant.off(ParticipantEvent.TrackUnpublished, onChange);
    };
  }, [localParticipant]);

  // Connection-quality watcher with debounce + recovery dismissal
  useEffect(() => {
    if (!localParticipant) return;

    const apply = (q: ConnectionQuality) => {
      const sev = severityFromQuality(q);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
      if (sev) {
        // Bad quality — debounce before showing
        debounceRef.current = setTimeout(() => {
          // Respect session-level dismissal for the same severity
          let suppressed: Severity = null;
          try {
            const raw = window.sessionStorage.getItem(SESSION_KEY);
            if (raw === "poor" || raw === "lost") suppressed = raw;
          } catch {
            /* ignore */
          }
          if (suppressed && suppressed === sev) return;
          setSeverity(sev);
          setVisible(true);
          lastShownSevRef.current = sev;
        }, DEBOUNCE_MS);
      } else if (lastShownSevRef.current) {
        // Recovered — auto-dismiss after a brief delay and clear suppression
        dismissTimerRef.current = setTimeout(() => {
          setVisible(false);
          lastShownSevRef.current = null;
          try {
            window.sessionStorage.removeItem(SESSION_KEY);
          } catch {
            /* ignore */
          }
        }, AUTO_DISMISS_MS);
      }
    };

    apply(localParticipant.connectionQuality);
    const onQuality = (q: ConnectionQuality) => apply(q);
    localParticipant.on(ParticipantEvent.ConnectionQualityChanged, onQuality);
    return () => {
      localParticipant.off(ParticipantEvent.ConnectionQualityChanged, onQuality);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [localParticipant]);

  const dismiss = useCallback(() => {
    setVisible(false);
    const sev = lastShownSevRef.current;
    if (sev) {
      try {
        window.sessionStorage.setItem(SESSION_KEY, sev);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const turnOffCamera = useCallback(async () => {
    if (!localParticipant) return;
    try {
      await localParticipant.setCameraEnabled(false);
    } catch {
      /* ignore */
    }
  }, [localParticipant]);

  if (!visible || !severity) return null;

  const { title, subtitle } = describe(severity);
  const isLost = severity === "lost";
  const accent = isLost ? "#ef4444" : "#f59e0b";

  return (
    <>
      <div
        role="status"
        aria-live={isLost ? "assertive" : "polite"}
        aria-atomic="true"
        className="neo-nqt-toast"
        style={{
          position: "fixed",
          top: 64,
          right: 16,
          zIndex: 9999,
          maxWidth: 320,
          padding: "12px 14px 12px 16px",
          background: "rgba(15,15,18,0.96)",
          color: "#fff",
          borderRadius: 10,
          border: `1px solid ${accent}`,
          borderLeftWidth: 4,
          boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          font: "13px/1.4 system-ui, -apple-system, sans-serif",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          animation: reducedMotion ? "none" : "neo-nqt-in 220ms ease-out",
        }}
      >

        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span
            aria-hidden="true"
            style={{
              flex: "0 0 auto",
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: accent,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0a0a0a",
              fontWeight: 700,
              fontSize: 12,
              lineHeight: 1,
            }}
          >
            {isLost ? "!" : "\u26A0"}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
            <div style={{ opacity: 0.8, fontSize: 12, marginTop: 2 }}>{subtitle}</div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            title="Dismiss"
            style={{
              flex: "0 0 auto",
              width: 24,
              height: 24,
              padding: 0,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "transparent",
              color: "rgba(255,255,255,0.7)",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
              lineHeight: 1,
            }}
          >
            {"\u00D7"}
          </button>
        </div>

        {severity === "poor" && cameraOn && (
          <button
            type="button"
            onClick={turnOffCamera}
            className="neo-nqt-action"
            style={{
              alignSelf: "flex-start",
              padding: "6px 10px",
              fontSize: 12,
              fontWeight: 600,
              color: "#0a0a0a",
              background: accent,
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Turn off camera
          </button>
        )}
      </div>
      <style>{`
@keyframes neo-nqt-in {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.neo-nqt-toast button.neo-nqt-action:hover { filter: brightness(1.08); }
.neo-nqt-toast button.neo-nqt-action:focus-visible,
.neo-nqt-toast button[aria-label="Dismiss"]:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
`}</style>
    </>
  );
}
