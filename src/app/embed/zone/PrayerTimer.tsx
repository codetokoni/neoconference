"use client";

// "Your Prayer Time" in the zone embed. The number comes from the server
// (src/lib/partners/attendance.ts), worked out from LiveKit's timestamps;
// the page only adds the seconds since the server's answer while the
// server says the visitor is connected. A slowed-down background tab or a
// reload cannot make it wrong: every tick recomputes from the clock, and
// every heartbeat (20 s) or return to the tab re-reads it.

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnectionState, useRoomContext } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";

const BEAT_MS = 20_000;

export type TimerReading = { sessionId: string | null; seconds: number; connected: boolean; serverNow: number };

/** 3725 -> "01:02:05". Hours keep counting past 99. */
export function formatPrayerTime(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Asks the server for the visitor's timer; with `sid`, also says that connection is still here. */
export async function readTimer(session: string, sid?: string): Promise<TimerReading | null> {
  try {
    const res = await fetch("/api/partner/embed/attendance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sid ? { session, sid } : { session }),
      cache: "no-store",
      credentials: "omit",
    });
    if (!res.ok) return null;
    const d = (await res.json()) as TimerReading;
    return typeof d.seconds === "number" ? d : null;
  } catch {
    return null;
  }
}

type Reading = TimerReading & { receivedAt: number };

function shown(r: Reading | null, live: boolean): number {
  if (!r) return 0;
  return r.seconds + (r.connected && live ? Math.max(0, (Date.now() - r.receivedAt) / 1000) : 0);
}

/** Inside <LiveKitRoom>: beats while connected and shows the visitor's prayer time. */
export function PrayerTimer({ getSession, onTick }: { getSession: () => string | null; onTick?: (seconds: number, connected: boolean, sessionId: string | null) => void }) {
  const room = useRoomContext();
  const state = useConnectionState();
  const live = state === ConnectionState.Connected;
  const [reading, setReading] = useState<Reading | null>(null);
  const [, setTick] = useState(0);
  const busy = useRef(false);

  const beat = useCallback(async () => {
    const session = getSession();
    const sid = room.localParticipant?.sid;
    if (!session || !sid || busy.current) return;
    busy.current = true;
    const r = await readTimer(session, sid);
    busy.current = false;
    if (r) setReading({ ...r, receivedAt: Date.now() });
  }, [getSession, room]);

  // Beat on connecting (and reconnecting), then every 20 s, and when the tab comes back.
  useEffect(() => {
    if (!live) return;
    void beat();
    const id = window.setInterval(() => void beat(), BEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, beat]);

  // Redraw every second; the value itself comes from the clock, not from counting ticks.
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const seconds = shown(reading, live);
  const counting = !!reading?.connected && live;
  const whole = Math.floor(seconds);
  useEffect(() => {
    onTick?.(whole, counting, reading?.sessionId ?? null);
  }, [whole, counting, reading?.sessionId, onTick]);

  return (
    <div
      data-room-chrome="true"
      className="nlm-prayer-timer"
      role="timer"
      aria-label={`Your prayer time ${formatPrayerTime(seconds)}${counting ? "" : ", paused"}`}
      style={{
        // Under the toolbar (about 60 px tall with two-line buttons on a phone).
        position: "absolute",
        top: 78,
        left: 8,
        zIndex: 13,
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 10,
        background: "rgba(11,16,32,0.8)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: "1px solid rgba(255,255,255,0.1)",
        color: "#e2e8f0",
        pointerEvents: "none",
      }}
    >
      <span style={{ fontSize: 11, opacity: 0.8 }}>Your Prayer Time</span>
      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 15, fontWeight: 600, letterSpacing: 0.5, fontVariantNumeric: "tabular-nums" }}>
        {formatPrayerTime(seconds)}
      </span>
      {reading && !counting && <span style={{ fontSize: 10, opacity: 0.6 }}>paused</span>}
    </div>
  );
}

/** After leaving: the visitor's prayer time in the session they were in, read once. */
export function PrayerTimeSoFar({ session }: { session: string | null }) {
  const [r, setR] = useState<TimerReading | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void readTimer(session).then((x) => {
      if (!cancelled) setR(x);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);
  if (!r || !r.sessionId || r.seconds <= 0) return null;
  return (
    <p className="mt-3 text-sm">
      Your prayer time this session: <strong style={{ fontVariantNumeric: "tabular-nums" }}>{formatPrayerTime(r.seconds)}</strong>
    </p>
  );
}
