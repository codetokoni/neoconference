"use client";

import { useCallback, useEffect, useState } from "react";
import Spotlight from "./Spotlight";

interface Participant {
  slot: number;
  name: string;
  code: string;
  streamId: string;
  live: boolean;
  claimed: boolean;
  meta?: Record<string, string>;
}

interface RoomPayload {
  ok: true;
  screen: number | "all";
  screens: number;
  perScreen: number;
  participants: Participant[];
  mainTrack: string;
  featured: { streamId: string; label: string; at: number } | null;
}

/**
 * Attendance-only board. Renders no video by default: 4 vCPU AMS with
 * 200 viewer slots is easy to burn if a floor manager keeps the camera
 * board open all afternoon. Polling /api/video/room every few seconds
 * costs nothing on that budget.
 *
 * Clicking a row opens a fullscreen Spotlight — one WebRTC subscription
 * for as long as the modal is open, closes on ✕ or Esc. This is the
 * cheap way to check on a specific child without spinning up an entire
 * camera board's worth of connections.
 *
 * Every participant across every screen appears in one list — the name
 * board's job is attendance-at-a-glance for the whole event, and paging
 * through Screen 1 / Screen 2 / … to find one row makes that harder,
 * not easier.
 */
export default function NameBoard({
  room,
  screen,
  display = false,
}: {
  room: string;
  /** Scope the board to just one screen's block of participants
   *  (Screen 1 = slots 1-50, Screen 2 = 51-100, …); unset = all. */
  screen?: number;
  /** Display mode strips producer chrome and hides participant codes
   *  so a moderator can project this to a physical screen without
   *  leaking passcodes to the audience. */
  display?: boolean;
}) {
  const [data, setData] = useState<RoomPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [spot, setSpot] = useState<Participant | null>(null);
  const [busy, setBusy] = useState(false);

  const scopeParam = screen ? String(screen) : "all";

  const load = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/video/room?room=${encodeURIComponent(room)}&screen=${scopeParam}`,
        { cache: "no-store" },
      );
      const j = await r.json();
      if (!j.ok) {
        setErr(
          j.error === "forbidden"
            ? "You do not have control-room access."
            : "Could not load.",
        );
        return;
      }
      setErr(null);
      setData(j as RoomPayload);
    } catch {
      /* transient */
    }
  }, [room, scopeParam]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const feature = useCallback(
    async (p: Participant) => {
      setBusy(true);
      try {
        await fetch(`/api/video/feature?room=${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            streamId: p.streamId,
            label: p.name,
            condition: p.meta?.condition,
            country: p.meta?.country,
          }),
        });
      } finally {
        setBusy(false);
      }
      setSpot(null);
    },
    [room],
  );

  const sendToPreview = useCallback(
    async (p: Participant) => {
      setBusy(true);
      try {
        await fetch(`/api/video/preview?room=${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ streamId: p.streamId, label: p.name }),
        });
      } finally {
        setBusy(false);
      }
      setSpot(null);
    },
    [room],
  );

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
    <>
      <div
        className={
          display
            ? "overflow-hidden bg-[#101820] text-[#DDE7EC]"
            : "overflow-hidden rounded-xl border border-white/12 bg-[#101820] text-[#DDE7EC] shadow-2xl"
        }
      >
        {!display && (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2.5">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-white/45">
              {data.participants.length} slots · {data.screens} screen
              {data.screens === 1 ? "" : "s"}
            </span>

            <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-white/45">
              {liveCount} live · {joinedCount} joined without camera · {notJoinedCount} not joined
            </span>

            <span className="ml-auto rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-300">
              zero viewer slots used
            </span>
          </div>
        )}

        <div
          className={
            display
              ? "grid gap-[3px] p-0 sm:grid-cols-2 lg:grid-cols-3"
              : "grid gap-[3px] p-3 sm:grid-cols-2 lg:grid-cols-3"
          }
        >
          {data.participants.map((p) => (
            <Row
              key={p.streamId}
              p={p}
              display={display}
              onOpen={() => setSpot(p)}
            />
          ))}
        </div>
      </div>

      {!display && spot && <Spotlight spot={spot} onClose={() => setSpot(null)} />}
    </>
  );
}

function Row({
  p,
  display,
  onOpen,
}: {
  p: Participant;
  display: boolean;
  onOpen: () => void;
}) {
  const state = p.live
    ? { label: "LIVE", tone: "bg-emerald-500/20 text-emerald-300 border-emerald-400/40" }
    : p.claimed
      ? { label: "JOINED", tone: "bg-amber-500/20 text-amber-300 border-amber-400/40" }
      : { label: "NOT JOINED", tone: "bg-white/[0.04] text-white/45 border-white/10" };

  const body = (
    <>
      <span className="w-8 font-mono text-[10px] text-white/45">
        {String(p.slot).padStart(2, "0")}
      </span>
      <span className="flex-1 truncate text-sm font-semibold text-white">{p.name}</span>
      {/* Passcode is deliberately omitted in display mode — the name
          board is often projected on a physical screen for the whole
          room to see, and showing every participant's code there would
          leak private join credentials. */}
      {!display && (
        <span className="font-mono text-[10px] text-white/45">{p.code}</span>
      )}
      <span
        className={
          "rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] " +
          state.tone
        }
      >
        {state.label}
      </span>
    </>
  );

  if (display) {
    return (
      <div className="flex w-full items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-left">
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-left transition hover:border-white/25 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
      aria-label={`Open ${p.name} fullscreen`}
    >
      {body}
    </button>
  );
}
