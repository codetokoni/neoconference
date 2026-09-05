"use client";

import { useCallback, useEffect, useState } from "react";

interface Participant {
  slot: number;
  name: string;
  code: string;
  streamId: string;
  live: boolean;
  claimed: boolean;
}

interface RoomPayload {
  ok: true;
  screen: number;
  screens: number;
  perScreen: number;
  participants: Participant[];
  mainTrack: string;
  featured: { streamId: string; label: string; at: number } | null;
}

/**
 * Attendance-only board. Deliberately renders no video: 4 vCPU AMS with
 * 200 viewer slots is easy to burn if a floor manager keeps the camera
 * board open all afternoon. Polling /api/video/room every few seconds
 * costs nothing on that budget.
 */
export default function NameBoard({
  room,
  screen,
}: {
  room: string;
  screen: number;
}) {
  const [data, setData] = useState<RoomPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/video/room?room=${encodeURIComponent(room)}&screen=${screen}`,
        { cache: "no-store" },
      );
      const j = await r.json();
      if (!j.ok) {
        setErr(
          j.error === "forbidden" ? "You do not have control-room access." : "Could not load.",
        );
        return;
      }
      setErr(null);
      setData(j as RoomPayload);
    } catch {
      /* transient */
    }
  }, [room, screen]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (err) return <p className="text-sm text-red-400">{err}</p>;
  if (!data) {
    return (
      <p className="font-mono text-xs uppercase tracking-[0.14em] text-white/45">
        Loading…
      </p>
    );
  }

  const liveCount = data.participants.filter((p) => p.live).length;
  const joinedCount = data.participants.filter((p) => !p.live && p.claimed).length;
  const notJoinedCount = data.participants.filter((p) => !p.claimed).length;

  return (
    <div className="overflow-hidden rounded-xl border border-white/12 bg-[#101820] text-[#DDE7EC] shadow-2xl">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2.5">
        {Array.from({ length: data.screens }, (_, i) => i + 1).map((n) => (
          <a
            key={n}
            href={`?room=${encodeURIComponent(room)}&screen=${n}`}
            className={[
              "rounded-md border px-3 py-1 text-xs transition",
              n === data.screen
                ? "border-transparent bg-emerald-600 text-white"
                : "border-white/12 bg-white/[0.03] text-white/70 hover:bg-white/10",
            ].join(" ")}
          >
            Screen {n}
          </a>
        ))}

        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-white/45">
          {liveCount} live · {joinedCount} joined without camera · {notJoinedCount} not joined
        </span>

        <span className="ml-auto rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-300">
          zero viewer slots used
        </span>
      </div>

      <div className="grid gap-[3px] p-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.participants.map((p) => (
          <Row key={p.streamId} p={p} />
        ))}
      </div>
    </div>
  );
}

function Row({ p }: { p: Participant }) {
  const state = p.live
    ? { label: "LIVE", tone: "bg-emerald-500/20 text-emerald-300 border-emerald-400/40" }
    : p.claimed
      ? { label: "JOINED", tone: "bg-amber-500/20 text-amber-300 border-amber-400/40" }
      : { label: "NOT JOINED", tone: "bg-white/[0.04] text-white/45 border-white/10" };

  return (
    <div className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2">
      <span className="w-8 font-mono text-[10px] text-white/45">
        {String(p.slot).padStart(2, "0")}
      </span>
      <span className="flex-1 truncate text-sm font-semibold text-white">{p.name}</span>
      <span className="font-mono text-[10px] text-white/45">{p.code}</span>
      <span
        className={
          "rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] " +
          state.tone
        }
      >
        {state.label}
      </span>
    </div>
  );
}
