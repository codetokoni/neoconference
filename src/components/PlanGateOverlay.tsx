"use client";

// src/components/PlanGateOverlay.tsx
//
// Client-side plan enforcement layer. Reads the host's planLimits encoded into
// the local participant's metadata by /api/livekit/token (see at.metadata in
// the token route).
//
// Responsibilities:
//   1. Meeting-length cap — counts down from when this component mounts. At
//      T-3 minutes it shows a banner; at T=0 it disconnects the room and
//      paints a full-screen "Upgrade" overlay.
//   2. Hide breakouts / recording UI elements via injected CSS when the
//      host's plan does not include those features.

import { useEffect, useMemo, useState } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import Link from "next/link";

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

export default function PlanGateOverlay() {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();

  const meta = useMemo(
    () => parseMeta(localParticipant?.metadata),
    [localParticipant?.metadata]
  );

  const limits = meta?.planLimits;
  const hostPlan = meta?.hostPlan ?? "free";

  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [ended, setEnded] = useState(false);

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

  if (!limits) return null;

  return (
    <>
      {secondsLeft !== null && secondsLeft > 0 && secondsLeft <= 180 && !ended && (
        <div
          data-room-chrome="true"
          className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] rounded-full bg-amber-500/95 text-slate-900 px-4 py-1.5 text-xs font-semibold shadow-lg flex items-center gap-2"
        >
          <span>
            {Math.floor(secondsLeft / 60)}:
            {String(secondsLeft % 60).padStart(2, "0")} left on Free plan
          </span>
          <Link
            href="/pricing"
            className="underline underline-offset-2 hover:no-underline"
          >
            Upgrade
          </Link>
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
