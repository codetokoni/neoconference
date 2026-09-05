"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAmsMultitrack } from "./useAmsMultitrack";
import { SIMULCAST_MAIN, type FeaturedState } from "@/lib/simulcast";

interface Participant {
  slot: number;
  name: string;
  code: string;
  streamId: string;
  live: boolean;
  claimed: boolean;
}

interface RoomPayload {
  screen: number;
  screens: number;
  mainTrack: string;
  participants: Participant[];
  layout: { order: string[]; hidden: string[] };
  featured: FeaturedState | null;
}

/**
 * One tile — one AMS play session, opened directly on p.streamId.
 *
 * Group-play of the mainTrack (all 50 subtracks over one PC) was the
 * elegant idea, but AMS delivers group subtracks under generic slot names
 * that don't identify the publisher, and no combination of trackList,
 * position mapping, or active-track detection lets us tell whose stream
 * is whose. The featured player has always played its subject as a
 * single stream and worked. Do the same per tile, gated on p.live.
 *
 * Cost: one WebRTC connection per LIVE participant (not per roster
 * slot). Empty slots keep zero connections open.
 */
function Tile({
  p,
  featured,
  monitored,
  onOpen,
  onHide,
  onDragStart,
  onDrop,
}: {
  p: Participant;
  featured: boolean;
  monitored: boolean;
  onOpen: () => void;
  onHide: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [over, setOver] = useState(false);

  const enabled = p.live && Boolean(p.streamId);
  const { videoStream } = useAmsMultitrack(p.streamId, enabled);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (enabled && videoStream && el.srcObject !== videoStream) {
      el.srcObject = videoStream;
      el.play().catch(() => {});
    }
    if (!enabled || !videoStream) el.srcObject = null;
  }, [enabled, videoStream]);

  useEffect(() => {
    if (ref.current) ref.current.muted = !monitored;
  }, [monitored]);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop();
      }}
      onClick={onOpen}
      className={[
        "group relative aspect-[4/3] cursor-grab overflow-hidden rounded border bg-[#16232B]",
        featured ? "border-amber-400 ring-1 ring-amber-400" : "border-white/10",
        over ? "ring-2 ring-emerald-400" : "",
      ].join(" ")}
    >
      <video ref={ref} playsInline autoPlay muted className="h-full w-full object-cover" />

      {!p.live && (
        <span className="absolute inset-0 flex items-center justify-center font-mono text-[9px] uppercase tracking-[0.14em] text-white/35">
          {p.claimed ? "joined, no camera" : "not joined"}
        </span>
      )}

      <span className="absolute left-1 top-0.5 font-mono text-[9.5px] text-white/70">
        {p.slot}
      </span>

      {featured && (
        <span className="absolute right-1 top-1 rounded-sm bg-amber-400 px-1 font-mono text-[8px] tracking-[0.1em] text-[#14100a]">
          ON AIR
        </span>
      )}

      {monitored && !featured && (
        <span className="absolute right-1 top-1 rounded-sm bg-emerald-500 px-1 font-mono text-[8px] tracking-[0.1em] text-white">
          MON
        </span>
      )}

      <button
        type="button"
        aria-label={`Hide ${p.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onHide();
        }}
        className="absolute right-0.5 top-0.5 hidden h-4 w-4 rounded-sm bg-black/60 text-[11px] leading-none text-white/80 group-hover:block focus:block"
      >
        ×
      </button>

      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/90 to-transparent px-1.5 py-0.5 text-[10px] font-semibold text-white/90">
        {p.name}
      </span>
    </div>
  );
}

/**
 * Spotlight modal — opens its own play session on the clicked participant.
 * Kept separate from Tile so it doesn't share the tile's muted state
 * (spotlighting implies the operator wants to hear the participant).
 */
function Spotlight({
  spot,
  busy,
  monitored,
  onFeature,
  onMonitor,
  onRemove,
  onClose,
}: {
  spot: Participant;
  busy: boolean;
  monitored: boolean;
  onFeature: () => void;
  onMonitor: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const { videoStream } = useAmsMultitrack(spot.streamId, Boolean(spot.streamId));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (videoStream && el.srcObject !== videoStream) {
      el.srcObject = videoStream;
      el.play().catch(() => {});
    }
  }, [videoStream]);

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/93 p-5">
      <video
        ref={ref}
        playsInline
        autoPlay
        className="aspect-[4/3] w-[min(640px,100%)] rounded-lg border border-white/10 bg-black object-cover"
      />
      <span className="font-mono text-xs text-white/70">
        {spot.name} · {spot.streamId} · {spot.code}
      </span>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onFeature}
          className="rounded-md bg-amber-500 px-4 py-2 text-sm font-semibold text-[#14100a] transition hover:bg-amber-400 disabled:opacity-40"
        >
          Feature to air
        </button>
        <button
          type="button"
          onClick={onMonitor}
          className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/85 transition hover:bg-white/10"
        >
          {monitored ? "Stop monitoring" : "Monitor audio"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onRemove}
          className="rounded-md border border-red-500/50 px-4 py-2 text-sm text-red-300 transition hover:bg-red-500/15 disabled:opacity-40"
        >
          Remove
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/85 transition hover:bg-white/10"
        >
          Close
        </button>
      </div>
    </div>
  );
}

export default function ControlRoom({
  room = SIMULCAST_MAIN,
  screen = 1,
}: {
  room?: string;
  screen?: number;
}) {
  const [data, setData] = useState<RoomPayload | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [monitor, setMonitor] = useState<string | null>(null);
  const [spot, setSpot] = useState<Participant | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dragId = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/video/room?room=${encodeURIComponent(room)}&screen=${screen}`,
        { cache: "no-store" },
      );
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error === "forbidden" ? "You do not have control-room access." : "Could not load.");
        return;
      }
      setErr(null);
      setData(j);
      setOrder((prev) => (prev.length ? prev : j.layout.order));
      setHidden((prev) => (prev.length ? prev : j.layout.hidden));
    } catch {
      /* transient */
    }
  }, [room, screen]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const saveLayout = useCallback(
    async (nextOrder: string[], nextHidden: string[]) => {
      try {
        await fetch(`/api/video/room?room=${encodeURIComponent(room)}&screen=${screen}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: nextOrder, hidden: nextHidden }),
        });
      } catch {
        /* the operator still sees their arrangement; it just is not shared yet */
      }
    },
    [room, screen],
  );

  /* Memoised: a fresh [] each render would recompute every list below and
     churn all fifty tiles. */
  const participants = useMemo(() => data?.participants ?? [], [data]);
  const bySlot = useMemo(() => {
    const m = new Map<string, Participant>();
    participants.forEach((p) => m.set(p.streamId, p));
    return m;
  }, [participants]);

  const visible = useMemo(() => {
    const hiddenSet = new Set(hidden);
    const ranked = participants.filter((p) => !hiddenSet.has(p.streamId));
    if (!order.length) return ranked;
    const pos = new Map(order.map((id, i) => [id, i]));
    return ranked.sort((a, b) => {
      const ai = pos.has(a.streamId) ? (pos.get(a.streamId) as number) : 9999 + a.slot;
      const bi = pos.has(b.streamId) ? (pos.get(b.streamId) as number) : 9999 + b.slot;
      return ai - bi;
    });
  }, [participants, order, hidden]);

  const hiddenList = useMemo(
    () => hidden.map((id) => bySlot.get(id)).filter(Boolean) as Participant[],
    [hidden, bySlot],
  );

  const featuredId = data?.featured?.streamId ?? null;

  const feature = useCallback(
    async (p: Participant | null) => {
      setBusy(true);
      try {
        await fetch(`/api/video/feature?room=${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            p ? { streamId: p.streamId, label: p.name } : { streamId: null },
          ),
        });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [room, load],
  );

  const remove = useCallback(
    async (p: Participant) => {
      if (!window.confirm(`Remove ${p.name}? Their camera stops and the code frees up.`)) return;
      setBusy(true);
      try {
        await fetch(
          `/api/video/room?room=${encodeURIComponent(room)}&streamId=${encodeURIComponent(p.streamId)}&code=${encodeURIComponent(p.code)}`,
          { method: "DELETE" },
        );
        setSpot(null);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [room, load],
  );

  const hide = useCallback(
    (p: Participant) => {
      const next = [...hidden, p.streamId];
      setHidden(next);
      if (monitor === p.streamId) setMonitor(null);
      saveLayout(order, next);
    },
    [hidden, order, monitor, saveLayout],
  );

  const restore = useCallback(
    (p: Participant) => {
      const next = hidden.filter((id) => id !== p.streamId);
      setHidden(next);
      saveLayout(order, next);
    },
    [hidden, order, saveLayout],
  );

  const dropOn = useCallback(
    (target: Participant) => {
      const from = dragId.current;
      dragId.current = null;
      if (!from || from === target.streamId) return;
      const ids = visible.map((p) => p.streamId);
      const a = ids.indexOf(from);
      const b = ids.indexOf(target.streamId);
      if (a === -1 || b === -1) return;
      ids.splice(b, 0, ids.splice(a, 1)[0]);
      setOrder(ids);
      saveLayout(ids, hidden);
    },
    [visible, hidden, saveLayout],
  );

  const liveCount = participants.filter((p) => p.live).length;

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[#101A20] text-[#DDE7EC] shadow-2xl">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2.5">
        {Array.from({ length: data?.screens ?? 1 }, (_, i) => i + 1).map((n) => (
          <a
            key={n}
            href={`?screen=${n}`}
            className={[
              "rounded-md border px-3 py-1 text-xs transition",
              n === screen
                ? "border-transparent bg-emerald-600 text-white"
                : "border-white/10 bg-white/5 text-white/70 hover:bg-white/10",
            ].join(" ")}
          >
            Screen {n}
          </a>
        ))}

        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-white/45">
          {liveCount} live · {hidden.length} hidden
        </span>

        <span className="ml-auto font-mono text-[10.5px] uppercase tracking-[0.12em] text-amber-300/90">
          {data?.featured ? `On air — ${data.featured.label}` : "On air — programme feed"}
        </span>

        <button
          type="button"
          disabled={busy || !data?.featured}
          onClick={() => feature(null)}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 transition hover:bg-white/10 disabled:opacity-40"
        >
          Back to programme
        </button>
      </div>

      {err && <p className="px-3 py-2 text-sm text-red-400">{err}</p>}

      <div className="relative">
        <div className="grid grid-cols-4 gap-[5px] p-3 sm:grid-cols-6 lg:grid-cols-10">
          {visible.map((p) => (
            <Tile
              key={p.streamId}
              p={p}
              featured={featuredId === p.streamId}
              monitored={monitor === p.streamId}
              onOpen={() => setSpot(p)}
              onHide={() => hide(p)}
              onDragStart={() => {
                dragId.current = p.streamId;
              }}
              onDrop={() => dropOn(p)}
            />
          ))}
        </div>

        {spot && (
          <Spotlight
            spot={spot}
            busy={busy}
            monitored={monitor === spot.streamId}
            onFeature={() => feature(spot)}
            onMonitor={() => setMonitor(monitor === spot.streamId ? null : spot.streamId)}
            onRemove={() => remove(spot)}
            onClose={() => setSpot(null)}
          />
        )}
      </div>

      <div className="flex min-h-[46px] flex-wrap items-center gap-2 border-t border-white/10 px-3 py-2.5">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-white/45">
          {hiddenList.length ? "Hidden" : "Hidden — none"}
        </span>
        {hiddenList.map((p) => (
          <span
            key={p.streamId}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1 pl-3 pr-1 text-xs text-white/75"
          >
            {p.name}
            <button
              type="button"
              onClick={() => restore(p)}
              className="rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] text-white"
            >
              restore
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
