"use client";

// src/components/PlanGateOverlay.tsx
//
// Client-side plan enforcement layer. Reads the host's planLimits encoded into
// the local participant's metadata by /api/livekit/token (see at.metadata in
// the token route).
//
// Responsibilities:
//   1. Meeting-length cap — counts down from when this component mounts. In
//      the last 5 minutes it shows a glass countdown widget that shifts
//      through amber -> orange -> red urgency tiers; at T=0 it disconnects
//      the room and paints a full-screen "Upgrade" overlay.
//   2. Hide breakouts / recording UI elements via injected CSS when the
//      host's plan does not include those features.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import Link from "next/link";
import { ArrowRight, Clock } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";

type PlanLimits = {
  meetingMinutes: number;
  maxParticipants: number;
  recording: boolean;
  recordingHoursPerMonth: number;
  breakouts: boolean;
  branding: boolean;
};

type TokenMeta = {
  planLimits?: PlanLimits;
  hostPlan?: "free" | "pro" | "business";
};

function parseMeta(raw: string | undefined | null): TokenMeta | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as TokenMeta;
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

const KEYFRAMES_ID = "__plan-gate-countdown-kf";

function ensureKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement("style");
  style.id = KEYFRAMES_ID;
  style.textContent = `
@keyframes plan-gate-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.7; }
}
@media (prefers-reduced-motion: reduce) {
  .plan-gate-pulse { animation: none !important; }
}
`;
  document.head.appendChild(style);
}

function formatMMSS(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function PlanGateOverlay() {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();
  const isMobile = useIsMobile();

  const meta = useMemo(
    () => parseMeta(localParticipant?.metadata),
    [localParticipant?.metadata]
  );

  const limits = meta?.planLimits;
  const hostPlan = meta?.hostPlan ?? "free";

  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    ensureKeyframes();
  }, []);

  useEffect(() => {
    if (!limits || !limits.meetingMinutes || limits.meetingMinutes <= 0) {
      setSecondsLeft(null);
      return;
    }
    const startMs = Date.now();
    const totalSec = limits.meetingMinutes * 60;
    setSecondsLeft(totalSec);
    const id = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startMs) / 1000);
      const left = Math.max(0, totalSec - elapsed);
      setSecondsLeft(left);
      if (left === 0) {
        try {
          room?.disconnect();
        } catch {}
        setEnded(true);
        window.clearInterval(id);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [limits, room]);

  useEffect(() => {
    if (!limits) return;
    const styleId = "nc-plan-gate-style";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    const rules: string[] = [];
    if (!limits.breakouts) {
      rules.push('[data-feature="breakouts"], [title="Toggle breakouts"] { display: none !important; }');
    }
    if (!limits.recording) {
      rules.push('[data-feature="recording"], [data-recording-control] { display: none !important; }');
    }
    style.textContent = rules.join("\n");
  }, [limits]);

  // Aria-live announcements: speak when entering the orange (<=3 min) or
  // red (<=1 min) tier, plus throttled 30s updates while in red. Amber is
  // the calm "heads up" state — the color is the signal, no speech.
  const prevTierRef = useRef<"none" | "amber" | "orange" | "red">("none");
  const announced = useMemo(() => {
    if (secondsLeft === null) return "";
    const tier: "none" | "amber" | "orange" | "red" =
      secondsLeft > 300 ? "none" :
      secondsLeft > 180 ? "amber" :
      secondsLeft > 60 ? "orange" : "red";
    const prev = prevTierRef.current;
    prevTierRef.current = tier;

    const enteredOrange = tier === "orange" && prev !== "orange" && prev !== "red";
    const enteredRed = tier === "red" && prev !== "red";
    const periodicRed = tier === "red" && secondsLeft % 30 === 0;
    if (!enteredOrange && !enteredRed && !periodicRed) return "";

    const m = Math.floor(secondsLeft / 60);
    const s = secondsLeft % 60;
    if (m > 0 && s === 0) return `${m} minute${m === 1 ? "" : "s"} left on Free plan`;
    if (m === 0) return `${s} seconds left on Free plan`;
    return `${m} minute${m === 1 ? "" : "s"} ${s} seconds left on Free plan`;
  }, [secondsLeft]);

  if (!limits) return null;

  const showWidget =
    secondsLeft !== null && secondsLeft > 0 && secondsLeft <= 300 && !ended;
  const tier: "amber" | "orange" | "red" =
    secondsLeft !== null && secondsLeft <= 60 ? "red" :
    secondsLeft !== null && secondsLeft <= 180 ? "orange" : "amber";
  const isRed = tier === "red";
  const countdownColor =
    tier === "red" ? "text-red-400" :
    tier === "orange" ? "text-orange-400" : "text-amber-400";

  return (
    <>
      {showWidget && (
        <div
          data-room-chrome="true"
          className={
            isMobile
              ? "fixed top-12 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-white/[0.08] bg-black/60 px-4 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.4)] backdrop-blur-xl"
              : "fixed top-3 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-white/[0.08] bg-black/60 px-4 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.4)] backdrop-blur-xl"
          }
          style={{ minWidth: isMobile ? undefined : 280, borderWidth: "0.5px" }}
        >
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
            <span className="text-[10px] font-medium uppercase tracking-widest text-zinc-400">
              Free plan
            </span>
          </div>

          <span className="h-5 w-px bg-white/10" aria-hidden="true" />

          <span
            className={`${
              isMobile ? "text-3xl" : "text-2xl"
            } font-bold tabular-nums leading-none ${countdownColor} ${
              isRed ? "plan-gate-pulse" : ""
            }`}
            style={isRed ? { animation: "plan-gate-pulse 1s ease-in-out infinite" } : undefined}
          >
            {formatMMSS(secondsLeft as number)}
          </span>

          <span className="h-5 w-px bg-white/10" aria-hidden="true" />

          <Link
            href="/pricing"
            aria-label="Upgrade to remove time limit"
            className="inline-flex items-center gap-1 rounded-full bg-cyan-500 px-3 py-1 text-xs font-medium text-black transition-colors hover:bg-cyan-400"
          >
            Upgrade
            {!isMobile && <ArrowRight className="h-3 w-3" aria-hidden="true" />}
          </Link>

          <span aria-live="polite" className="sr-only">
            {announced}
          </span>
        </div>
      )}

      {ended && (
        <div
          data-room-chrome="true"
          className="fixed inset-0 z-[100] bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-6"
        >
          <div className="max-w-md w-full rounded-2xl border border-white/10 bg-gradient-to-b from-cyan-500/10 to-indigo-500/5 p-8 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-cyan-400/15 border border-cyan-300/30 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-cyan-300" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4l3 2" />
              </svg>
            </div>
            <h2 className="mt-5 text-2xl font-bold text-white">
              Meeting ended
            </h2>
            <p className="mt-2 text-sm text-cyan-100/70">
              Free plan meetings cap at {limits.meetingMinutes} minutes. Upgrade to keep going without interruptions.
            </p>
            <div className="mt-6 flex flex-col sm:flex-row gap-2">
              <Link
                href="/pricing"
                className="flex-1 inline-flex justify-center items-center text-sm font-semibold px-5 py-3 rounded-xl bg-cyan-400 text-slate-900 hover:bg-cyan-300 transition"
              >
                See plans
              </Link>
              <Link
                href="/dashboard"
                className="flex-1 inline-flex justify-center items-center text-sm font-semibold px-5 py-3 rounded-xl border border-white/20 text-white hover:bg-white/5 transition"
              >
                Back to dashboard
              </Link>
            </div>
            <p className="mt-4 text-[10px] uppercase tracking-wider text-cyan-100/40">
              Host plan: {hostPlan}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
