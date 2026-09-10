"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  showCodes = false,
}: {
  room: string;
  /** Scope the board to just one screen's block of participants
   *  (Screen 1 = slots 1-50, Screen 2 = 51-100, …); unset = all. */
  screen?: number;
  /** Display mode strips producer chrome and hides participant codes
   *  so a moderator can project this to a physical screen without
   *  leaking passcodes to the audience. */
  display?: boolean;
  /** Opt-in override that reveals passcodes even in display mode.
   *  For a moderator running the projected view on their own laptop,
   *  never on a screen the audience can see. Ignored outside display
   *  mode (producer mode already shows codes). */
  showCodes?: boolean;
}) {
  const [data, setData] = useState<RoomPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [spot, setSpot] = useState<Participant | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

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

  // `/` focuses the search box (Gmail / GitHub muscle memory); Esc
  // while focused clears the query. Skip when the user is already
  // typing somewhere else so we don't steal keystrokes.
  useEffect(() => {
    const isTypingElsewhere = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        el.isContentEditable
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !isTypingElsewhere() && !spot) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spot]);

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

  // Search matches name (case-insensitive substring), code (any
  // substring), or slot number (as digits). Empty query = show all.
  // Uses the RAW list every render — cheap even at 2000 rows since
  // each participant is a couple of string checks.
  const filtered = data.participants.filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    if (p.name.toLowerCase().includes(q)) return true;
    if (p.code.toLowerCase().includes(q)) return true;
    if (String(p.slot).includes(q)) return true;
    return false;
  });

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
              {query ? `${filtered.length} of ${data.participants.length}` : `${data.participants.length} slots`}
              {" · "}
              {data.screens} screen{data.screens === 1 ? "" : "s"}
            </span>

            <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-white/45">
              {liveCount} live · {joinedCount} joined without camera · {notJoinedCount} not joined
            </span>

            <span className="ml-auto rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-300">
              zero viewer slots used
            </span>
          </div>
        )}

        {/* Search bar. Sticky at the top so it stays reachable while
            scrolling a 2000-row roster. Same shape in producer and
            display modes; the sizing scales with legibility rules. */}
        <div
          className={
            display
              ? "sticky top-0 z-10 border-b border-white/10 bg-[#101820]/95 px-3 py-2 backdrop-blur"
              : "sticky top-0 z-10 border-b border-white/10 bg-[#101820]/95 px-3 py-2 backdrop-blur"
          }
        >
          <div className="relative">
            <input
              ref={searchRef}
              type="search"
              inputMode="search"
              placeholder={
                display
                  ? "Search name, code, or slot number"
                  : "Search name, code, or slot number   (press / to focus)"
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className={
                display
                  ? "w-full rounded-md border border-white/15 bg-white/[0.04] px-3 py-2 text-base text-white placeholder:text-white/40 focus:border-emerald-400/60 focus:outline-none"
                  : "w-full rounded-md border border-white/15 bg-white/[0.04] px-3 py-1.5 text-sm text-white placeholder:text-white/40 focus:border-emerald-400/60 focus:outline-none"
              }
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs text-white/60 hover:bg-white/10 hover:text-white/90"
              >
                clear
              </button>
            )}
          </div>
          {display && query && (
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
              {filtered.length} of {data.participants.length}
            </p>
          )}
        </div>

        <div
          className={
            display
              ? "grid gap-[3px] p-0 sm:grid-cols-2 lg:grid-cols-3"
              : "grid gap-[3px] p-3 sm:grid-cols-2 lg:grid-cols-3"
          }
        >
          {filtered.map((p) => (
            <Row
              key={p.streamId}
              p={p}
              display={display}
              showCodes={showCodes}
              onOpen={() => setSpot(p)}
            />
          ))}
          {filtered.length === 0 && (
            <p className="col-span-full px-3 py-8 text-center text-sm text-white/50">
              No participants match &ldquo;{query}&rdquo;.
            </p>
          )}
        </div>
      </div>

      {/* Spotlight opens in display mode too — a moderator projecting
          the name board can tap any row to pull that participant's
          camera up full-screen for the room to see. Arrow keys walk
          the roster in the order it's rendered on screen so a
          "one-by-one" flow doesn't need a return to the board
          between people. */}
      {spot && (
        <Spotlight
          spot={spot}
          onClose={() => setSpot(null)}
          onPrev={() => {
            // Walk the FILTERED list, so arrow-key navigation follows
            // the search results the moderator is looking at rather
            // than jumping back into rows they've filtered out.
            const i = filtered.findIndex((p) => p.streamId === spot.streamId);
            if (i > 0) setSpot(filtered[i - 1]);
          }}
          onNext={() => {
            const i = filtered.findIndex((p) => p.streamId === spot.streamId);
            if (i >= 0 && i < filtered.length - 1) setSpot(filtered[i + 1]);
          }}
        />
      )}
    </>
  );
}

function Row({
  p,
  display,
  showCodes,
  onOpen,
}: {
  p: Participant;
  display: boolean;
  showCodes: boolean;
  onOpen: () => void;
}) {
  const state = p.live
    ? { label: "LIVE", tone: "bg-emerald-500/20 text-emerald-300 border-emerald-400/40" }
    : p.claimed
      ? { label: "JOINED", tone: "bg-amber-500/20 text-amber-300 border-amber-400/40" }
      : { label: "NOT JOINED", tone: "bg-white/[0.04] text-white/45 border-white/10" };

  // Text scales up in display mode so numbers + names are legible
  // when the board is projected on a physical screen from a few
  // meters away. Producer-mode chrome (compact rows) is unchanged.
  const slotClass = display
    ? "w-10 font-mono text-sm text-white/60"
    : "w-8 font-mono text-[10px] text-white/45";
  const nameClass = display
    ? "flex-1 truncate text-lg font-semibold text-white"
    : "flex-1 truncate text-sm font-semibold text-white";
  const statusClass = display
    ? "rounded-sm border px-2 py-1 font-mono text-[11px] uppercase tracking-[0.14em] "
    : "rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] ";
  const rowClass = display
    ? "flex w-full items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-3 text-left transition hover:border-white/25 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
    : "flex w-full items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-left transition hover:border-white/25 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400";

  const body = (
    <>
      <span className={slotClass}>{String(p.slot).padStart(2, "0")}</span>
      <span className={nameClass}>{p.name}</span>
      {/* Passcode is omitted in display mode by default — the name
          board is often projected on a physical screen for the whole
          room to see, and showing every participant's code there
          would leak private join credentials. Producer mode always
          shows the code (it's the operator's own screen). A
          moderator running display mode on their OWN laptop can pass
          `?codes=1` to opt in; the code text scales up so they can
          read it from a normal seating distance. */}
      {!display && (
        <span className="font-mono text-[10px] text-white/45">{p.code}</span>
      )}
      {display && showCodes && (
        <span className="font-mono text-base text-amber-200/85">{p.code}</span>
      )}
      <span className={statusClass + state.tone}>{state.label}</span>
    </>
  );

  // Rows are now buttons in every mode so a moderator can tap any
  // name in display mode to open that participant's camera fullscreen
  // (matches the camera-board affordance).
  return (
    <button
      type="button"
      onClick={onOpen}
      className={rowClass}
      aria-label={`Open ${p.name} fullscreen`}
    >
      {body}
    </button>
  );
}
