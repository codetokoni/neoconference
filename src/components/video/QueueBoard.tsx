"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAmsMultitrack } from "./useAmsMultitrack";
import Spotlight from "./Spotlight";
import { roomLink } from "@/lib/simulcast";

interface Participant {
  slot: number;
  name: string;
  code: string;
  streamId: string;
  live: boolean;
  claimed: boolean;
  /** Roster meta — used to overlay a lower third on the featured
   *  video when this participant is taken to air. Optional; rooms
   *  without a roster upload have no meta. */
  meta?: Record<string, string>;
}

interface Queue {
  slug: string;
  name: string;
  order: string[];
}

/**
 * Detail view of one queue.
 *
 * Renders as a tile grid — the same look as the Camera board — but
 * filtered to only the participants staged in this queue. Each tile
 * plays that participant's own AMS stream if they're live, so a
 * producer can see the person before featuring them, and click the
 * tile to take it to air. Not-joined and joined-no-camera tiles show
 * a text placeholder in the same shape so the grid stays uniform.
 *
 * Reorder + remove live on the tile itself; the "Take to air" action
 * writes to /api/video/feature, matching every other cut in the app.
 * The Send-to-preview action writes to /api/video/preview so the
 * cameras board's preview pane picks it up too.
 */
/** How many entries fit on one projected screen. Matches the
 *  camera / name board screen size so operators only need to
 *  remember one number. */
const PAGE_SIZE = 50;

export default function QueueBoard({
  room,
  slug,
  display = false,
  screen,
}: {
  room: string;
  slug: string;
  /** Display mode: hide producer controls (delete queue, add form,
   *  reorder + take-to-air affordances on tiles) so the projected
   *  view is a clean grid of who's queued. */
  display?: boolean;
  /** Display mode only. 1-indexed page number — page 1 shows the
   *  first PAGE_SIZE entries, page 2 the next PAGE_SIZE, and so on.
   *  A queue longer than PAGE_SIZE auto-creates pages; a moderator
   *  puts one on each projector. Ignored outside display mode; the
   *  producer view always shows the whole queue. */
  screen?: number;
}) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addInput, setAddInput] = useState("");
  const [spot, setSpot] = useState<Participant | null>(null);

  const load = useCallback(async () => {
    try {
      const [qRes, sRes] = await Promise.all([
        fetch(
          `/api/video/queues/${encodeURIComponent(slug)}?room=${encodeURIComponent(room)}`,
          { cache: "no-store" },
        ),
        fetch(`/api/video/room/summary?room=${encodeURIComponent(room)}`, {
          cache: "no-store",
        }),
      ]);
      const qJ = await qRes.json();
      const sJ = await sRes.json();
      if (!qJ.ok) {
        setErr(
          qJ.error === "forbidden"
            ? "You do not have control-room access."
            : qJ.error ?? "Queue not found.",
        );
        return;
      }
      if (!sJ.ok) return;
      setErr(null);
      setQueue(qJ.queue);

      const screens: number = sJ.screens ?? 1;
      const results = await Promise.all(
        Array.from({ length: screens }, (_, i) => i + 1).map((n) =>
          fetch(
            `/api/video/room?room=${encodeURIComponent(room)}&screen=${n}`,
            { cache: "no-store" },
          ).then((r) => r.json()),
        ),
      );
      const flat: Participant[] = [];
      for (const r of results) {
        if (r.ok && Array.isArray(r.participants)) flat.push(...r.participants);
      }
      setParticipants(flat);
    } catch {
      /* transient */
    }
  }, [room, slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const patchOrder = useCallback(
    async (nextOrder: string[]) => {
      setQueue((q) => (q ? { ...q, order: nextOrder } : q));
      try {
        await fetch(
          `/api/video/queues/${encodeURIComponent(slug)}?room=${encodeURIComponent(room)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: nextOrder }),
          },
        );
      } catch {
        /* next poll reconciles */
      }
    },
    [room, slug],
  );

  const moveEntry = useCallback(
    (streamId: string, direction: -1 | 1) => {
      if (!queue) return;
      const idx = queue.order.indexOf(streamId);
      if (idx < 0) return;
      const next = idx + direction;
      if (next < 0 || next >= queue.order.length) return;
      const arr = [...queue.order];
      [arr[idx], arr[next]] = [arr[next], arr[idx]];
      patchOrder(arr);
    },
    [queue, patchOrder],
  );

  const removeEntry = useCallback(
    (streamId: string) => {
      if (!queue) return;
      patchOrder(queue.order.filter((s) => s !== streamId));
    },
    [queue, patchOrder],
  );

  const addEntry = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!queue) return;
      // Bulk-friendly parse: split on any whitespace, comma, or
      // semicolon so an operator can paste a WhatsApp list, a CSV
      // column, or a space-separated cheat sheet. Empty tokens are
      // filtered out so trailing punctuation doesn't create ghost
      // entries.
      const tokens = addInput
        .split(/[\s,;]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (tokens.length === 0) return;

      const resolveToken = (raw: string): Participant | undefined => {
        const asSlot = Number(raw);
        if (Number.isFinite(asSlot) && asSlot > 0) {
          const bySlot = participants.find((p) => p.slot === asSlot);
          if (bySlot) return bySlot;
        }
        const upper = raw.toUpperCase();
        return participants.find((p) => p.code.toUpperCase() === upper);
      };

      const alreadyQueued: string[] = [];
      const notFound: string[] = [];
      const seen = new Set(queue.order);
      const toAdd: string[] = [];

      for (const raw of tokens) {
        const p = resolveToken(raw);
        if (!p) {
          notFound.push(raw);
          continue;
        }
        if (seen.has(p.streamId)) {
          alreadyQueued.push(p.name);
          continue;
        }
        seen.add(p.streamId);
        toAdd.push(p.streamId);
      }

      const parts: string[] = [];
      if (toAdd.length > 0) parts.push(`${toAdd.length} added`);
      if (alreadyQueued.length > 0) {
        parts.push(
          `${alreadyQueued.length} already queued (${alreadyQueued.slice(0, 3).join(", ")}${alreadyQueued.length > 3 ? "…" : ""})`,
        );
      }
      if (notFound.length > 0) {
        parts.push(
          `${notFound.length} not found (${notFound.slice(0, 3).join(", ")}${notFound.length > 3 ? "…" : ""})`,
        );
      }

      if (toAdd.length === 0) {
        setErr(parts.join(" · ") || `No participant matches "${addInput.trim()}".`);
        return;
      }
      setErr(notFound.length + alreadyQueued.length > 0 ? parts.join(" · ") : null);
      await patchOrder([...queue.order, ...toAdd]);
      setAddInput("");
    },
    [addInput, participants, queue, patchOrder],
  );

  const takeToAir = useCallback(
    async (streamId: string, label: string) => {
      if (!queue) return;
      setBusy(true);
      try {
        // Pull condition + country from the participant's roster meta
        // so the featured video renders a proper lower third instead
        // of just a name. Missing fields are fine — the overlay
        // collapses gracefully. Look up via participants array to
        // avoid a use-before-declaration on bySid.
        const p = participants.find((x) => x.streamId === streamId);
        await fetch(`/api/video/feature?room=${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            streamId,
            label,
            condition: p?.meta?.condition,
            country: p?.meta?.country,
          }),
        });
        // Broadcast convention: after a Take, drop from queue. Producer can
        // re-queue the entry if they want to bring them back.
        await patchOrder(queue.order.filter((s) => s !== streamId));
      } finally {
        setBusy(false);
      }
    },
    [room, queue, patchOrder, participants],
  );

  const sendToPreview = useCallback(
    async (streamId: string, label: string) => {
      setBusy(true);
      try {
        await fetch(`/api/video/preview?room=${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ streamId, label }),
        });
      } finally {
        setBusy(false);
      }
    },
    [room],
  );

  const removeQueueEntirely = useCallback(async () => {
    if (!queue) return;
    if (
      !window.confirm(
        `Delete the "${queue.name}" queue? Entries are removed. Participants themselves are unaffected.`,
      )
    ) {
      return;
    }
    await fetch(
      `/api/video/queues/${encodeURIComponent(slug)}?room=${encodeURIComponent(room)}`,
      { method: "DELETE" },
    );
    window.location.href = `/video/room/queue${roomLink(room)}`;
  }, [room, slug, queue]);

  const bySid = useMemo(
    () => new Map(participants.map((p) => [p.streamId, p])),
    [participants],
  );

  const liveCount = useMemo(() => {
    if (!queue) return 0;
    let n = 0;
    for (const sid of queue.order) if (bySid.get(sid)?.live) n += 1;
    return n;
  }, [queue, bySid]);

  if (err && !queue) return <p className="text-sm text-red-400">{err}</p>;
  if (!queue) {
    return (
      <p className="font-mono text-xs uppercase tracking-[0.14em] text-white/45">
        Loading…
      </p>
    );
  }

  if (display) {
    // Projection layout: just the tile grid, edge-to-edge, no
    // producer chrome. The queue tiles themselves are still marked
    // with position + NEXT so the room can see who is up.
    const pages = Math.max(1, Math.ceil(queue.order.length / PAGE_SIZE));
    const page = Math.min(Math.max(1, screen ?? 1), pages);
    const startIdx = (page - 1) * PAGE_SIZE;
    const pageEntries = queue.order.slice(startIdx, startIdx + PAGE_SIZE);

    return queue.order.length === 0 ? (
      <div className="flex h-full items-center justify-center bg-[#0F1519] p-6 text-center">
        <p className="font-mono text-sm uppercase tracking-[0.14em] text-white/45">
          {queue.name} · queue is empty
        </p>
      </div>
    ) : (
      <div className="flex h-full flex-col overflow-hidden bg-[#0F1519] p-0">
        {/* Screen-of-N chip so the moderator can confirm which page a
            given projector is on. Only shown when the queue actually
            spans more than one page — a single-screen queue doesn't
            need the chrome. */}
        {pages > 1 && (
          <div className="flex items-center justify-between border-b border-white/8 bg-black/30 px-3 py-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/60">
              {queue.name} · screen {page} of {pages}
            </span>
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/40">
              positions {startIdx + 1}–{startIdx + pageEntries.length}
            </span>
          </div>
        )}
        {/* 10 cols × 5 rows = PAGE_SIZE (50) tiles that split the
            viewport evenly. Tiles drop their 4:3 aspect in display
            mode and fill the grid cell. This ONLY works because
            display mode is paginated at 50 — see the display branch
            in page.tsx for why fit-to-viewport is safe here. */}
        <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-4 gap-[3px] sm:grid-cols-6 lg:grid-cols-10">
          {pageEntries.map((sid, iOnPage) => {
            const globalIdx = startIdx + iOnPage;
            return (
              <QueueTile
                key={sid}
                streamId={sid}
                participant={bySid.get(sid)}
                position={globalIdx + 1}
                first={globalIdx === 0}
                last={globalIdx === queue.order.length - 1}
                busy={false}
                display
                onOpen={() => {
                  const p = bySid.get(sid);
                  if (p) setSpot(p);
                }}
                onUp={() => {}}
                onDown={() => {}}
                onRemove={() => {}}
                onTake={() => {}}
                onPreview={() => {}}
              />
            );
          })}
        </div>

        {/* Spotlight in display mode too — a moderator projecting the
            queue can tap any tile to pull that participant's camera
            up full-screen for the room to see. ← / → walk the queue
            order (from #210). */}
        {spot && (
          <Spotlight
            spot={spot}
            onClose={() => setSpot(null)}
            onPrev={() => {
              const order = queue.order;
              const i = order.findIndex((s) => s === spot.streamId);
              if (i > 0) {
                const p = bySid.get(order[i - 1]);
                if (p) setSpot(p);
              }
            }}
            onNext={() => {
              const order = queue.order;
              const i = order.findIndex((s) => s === spot.streamId);
              if (i >= 0 && i < order.length - 1) {
                const p = bySid.get(order[i + 1]);
                if (p) setSpot(p);
              }
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {err && <p className="text-sm text-red-400">{err}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/12 bg-[#141C22] p-4">
        <div className="flex flex-col">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
            Queue
          </span>
          <span className="text-xl font-bold text-white">{queue.name}</span>
          <span className="font-mono text-[10px] text-white/35">
            /{queue.slug} · {queue.order.length} staged · {liveCount} live
          </span>
        </div>
        <button
          type="button"
          onClick={removeQueueEntirely}
          className="rounded-md border border-red-500/50 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/15"
        >
          Delete queue
        </button>
      </div>

      <form
        onSubmit={addEntry}
        className="flex flex-wrap items-end gap-2 rounded-xl border border-white/12 bg-[#141C22] p-4"
      >
        <label className="flex flex-1 flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            Add participants — slot numbers or codes (space, comma, or newline)
          </span>
          {/* textarea, not input, so a paste from WhatsApp / a CSV /
              a sheet can span multiple lines. maxLength stays generous
              — the tokeniser handles whatever the operator pastes. */}
          <textarea
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            maxLength={2000}
            rows={2}
            onKeyDown={(e) => {
              // Enter submits, Shift+Enter inserts a newline — matches
              // how chat inputs work, so the muscle memory carries.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
              }
            }}
            placeholder="e.g. 7  528401  964270 753749"
            className="w-full resize-y rounded-md border border-white/12 bg-[#0B1319] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:ring-2 focus:ring-emerald-500"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !addInput.trim()}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          Add
        </button>
      </form>

      {/* Cheat sheet for the click model — a moderator hitting this
          page for the first time was clicking tiles expecting a
          preview, but tile-click used to take-to-air (and drop from
          the queue) which read as "the tile just closed". Now click
          previews; the red AIR button is the explicit go-to-air. */}
      <p className="rounded-md border border-white/8 bg-white/[0.02] px-3 py-2 text-xs text-white/60">
        Click a tile to preview. Use the red <span className="mx-0.5 rounded-sm bg-red-600 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-white">AIR</span> button on a tile to take that participant to air (removes them from the queue). Hover for reorder / preview / remove.
      </p>

      {/* Projector links — one URL per 50-entry page. The queue only
          needs page 2+ when the roster has grown past PAGE_SIZE; up
          to that point the single default link is all a moderator
          uses. Opening each URL in its own browser window (or
          casting to a projector) puts different positions on
          different screens. */}
      {queue.order.length > 0 && (
        <div className="rounded-md border border-white/8 bg-white/[0.02] px-3 py-2 text-xs text-white/60">
          <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            Present on screen
          </span>
          {Array.from(
            { length: Math.max(1, Math.ceil(queue.order.length / PAGE_SIZE)) },
            (_, i) => i + 1,
          ).map((n) => {
            const start = (n - 1) * PAGE_SIZE + 1;
            const end = Math.min(n * PAGE_SIZE, queue.order.length);
            // Short form: `?display=N` encodes both "display mode on"
            // and "page N" in one param. The `[slug]/page` route
            // still accepts the older `?display=1&screen=N` too, so
            // any bookmark already saved from a previous version
            // keeps working.
            return (
              <a
                key={n}
                href={`/video/room/${encodeURIComponent(slug)}${roomLink(room, { display: n })}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mr-2 inline-flex items-center gap-1 rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-200 hover:bg-emerald-500/20"
              >
                Screen {n} <span className="font-mono text-[10px] text-emerald-300/70">({start}–{end})</span>
              </a>
            );
          })}
        </div>
      )}

      {queue.order.length === 0 ? (
        <p className="rounded-lg border border-white/12 bg-[#101820] p-4 text-sm text-white/60">
          No entries yet. Add participants by slot number or code above.
        </p>
      ) : (
        <div className="rounded-xl border border-white/12 bg-[#0F1519] p-3">
          {/* Same 4/6/10-col grid as the Camera board (ControlRoom)
              so a moderator switching between boards sees identical
              tile density. The parent container is max-w-[1600px]
              to match, giving ~153px tiles at lg — plenty of room
              for the AIR button and the name at rest. */}
          <div className="grid grid-cols-4 gap-[5px] sm:grid-cols-6 lg:grid-cols-10">
            {queue.order.map((sid, i) => (
              <QueueTile
                key={sid}
                streamId={sid}
                participant={bySid.get(sid)}
                position={i + 1}
                first={i === 0}
                last={i === queue.order.length - 1}
                busy={busy}
                onOpen={() => {
                  const p = bySid.get(sid);
                  if (p) setSpot(p);
                }}
                onUp={() => moveEntry(sid, -1)}
                onDown={() => moveEntry(sid, 1)}
                onRemove={() => removeEntry(sid)}
                onTake={() =>
                  takeToAir(sid, bySid.get(sid)?.name ?? sid)
                }
                onPreview={() =>
                  sendToPreview(sid, bySid.get(sid)?.name ?? sid)
                }
              />
            ))}
          </div>
        </div>
      )}

      {spot && (
        <Spotlight
          spot={spot}
          onClose={() => setSpot(null)}
          onPrev={() => {
            if (!queue) return;
            const order = queue.order;
            const i = order.findIndex((s) => s === spot.streamId);
            if (i > 0) {
              const p = bySid.get(order[i - 1]);
              if (p) setSpot(p);
            }
          }}
          onNext={() => {
            if (!queue) return;
            const order = queue.order;
            const i = order.findIndex((s) => s === spot.streamId);
            if (i >= 0 && i < order.length - 1) {
              const p = bySid.get(order[i + 1]);
              if (p) setSpot(p);
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * One tile in the queue grid. Same shape as the Camera board's tile
 * (aspect-4/3, slot number top-left, name bottom, video for live
 * participants) so a producer flipping between the two boards reads
 * the layout instantly.
 *
 * Click model: tile click opens Spotlight (safe preview, same as the
 * camera board). The persistent red AIR button in the bottom-right
 * takes to air — the destructive action lives on an explicit
 * affordance, not on the whole tile, so a moderator never puts
 * someone on air by mistake.
 */
function QueueTile({
  streamId,
  participant,
  position,
  first,
  last,
  busy,
  display = false,
  onOpen,
  onUp,
  onDown,
  onRemove,
  onTake,
  onPreview,
}: {
  streamId: string;
  participant: Participant | undefined;
  position: number;
  first: boolean;
  last: boolean;
  busy: boolean;
  /** Display mode: no click-to-take, no hover controls, no cursor. */
  display?: boolean;
  onOpen?: () => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  onTake: () => void;
  onPreview: () => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const enabled = Boolean(participant?.live) && Boolean(streamId);
  const { videoStream } = useAmsMultitrack(streamId, enabled);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (enabled && videoStream && el.srcObject !== videoStream) {
      el.srcObject = videoStream;
      el.play().catch(() => {});
    }
    if (!enabled || !videoStream) el.srcObject = null;
  }, [enabled, videoStream]);

  const status = participant?.live
    ? "LIVE"
    : participant?.claimed
      ? "JOINED, NO CAMERA"
      : participant
        ? "NOT JOINED"
        : "UNKNOWN";

  return (
    <div
      // Click opens Spotlight in BOTH modes now. Take-to-air stays on
      // the persistent red AIR button (producer only) so the whole-tile
      // click never triggers something destructive.
      onClick={busy ? undefined : onOpen}
      className={
        "group relative overflow-hidden rounded border bg-[#16232B] " +
        // In display mode the tile fills its grid cell (parent uses
        // `auto-rows-fr` with fixed cols so 50 tiles split the
        // viewport into a 10x5 mosaic). Producer mode keeps the 4:3
        // aspect so scrolling grids look uniform.
        (display ? "h-full w-full cursor-pointer " : "aspect-[4/3] cursor-pointer ") +
        (first
          ? "border-amber-400 ring-1 ring-amber-400"
          : participant?.live
            ? "border-emerald-500/40"
            : "border-white/10")
      }
      title={
        display
          ? participant?.name ?? streamId
          : participant
            ? `Position ${position} — ${participant.name}. Click to preview; use AIR to take to air.`
            : streamId
      }
    >
      <video ref={ref} playsInline autoPlay muted className="h-full w-full object-cover" />

      {!participant?.live && (
        <span className="absolute inset-0 flex items-center justify-center px-1 text-center font-mono text-[8.5px] uppercase tracking-[0.14em] text-white/40">
          {status}
        </span>
      )}

      <span className="absolute left-1 top-0.5 font-mono text-[9.5px] text-white/70">
        {participant?.slot ?? "??"}
      </span>

      <span className="absolute right-1 top-0.5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-white/70">
        #{position}
      </span>

      {first && (
        <span className="absolute right-1 top-4 rounded-sm bg-amber-400 px-1 font-mono text-[8px] tracking-[0.1em] text-[#14100a]">
          NEXT
        </span>
      )}

      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/90 to-transparent px-1.5 py-0.5 pr-12 text-[10px] font-semibold text-white/90">
        {participant?.name ?? streamId}
      </span>

      {/* Persistent AIR button — the destructive "take to air" now
          lives on an explicit affordance, not the whole tile. Red to
          telegraph "this is broadcast-live", stopPropagation so the
          click doesn't also fire the tile's preview open. */}
      {!display && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTake();
          }}
          disabled={busy}
          className="absolute bottom-1 right-1 rounded-sm bg-red-600 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-white shadow hover:bg-red-500 disabled:opacity-40"
          title="Take this participant to air (removes them from the queue)"
        >
          Air ▶
        </button>
      )}

      {/* Hover controls — appear only on hover so a resting tile looks
          like a Camera board tile. stopPropagation on each so clicking
          them doesn't also trigger the tile's take-to-air. Suppressed
          entirely in display mode. */}
      {!display && (
      <div className="absolute inset-x-0 top-[38%] hidden justify-center gap-1 group-hover:flex">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPreview();
          }}
          disabled={busy}
          className="rounded-sm bg-black/70 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-white/85 hover:bg-black/90 disabled:opacity-40"
          title="Send to preview"
        >
          PVW
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onUp();
          }}
          disabled={first}
          className="rounded-sm bg-black/70 px-1.5 py-0.5 font-mono text-[9px] text-white/85 hover:bg-black/90 disabled:opacity-30"
          title="Move up"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDown();
          }}
          disabled={last}
          className="rounded-sm bg-black/70 px-1.5 py-0.5 font-mono text-[9px] text-white/85 hover:bg-black/90 disabled:opacity-30"
          title="Move down"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="rounded-sm bg-black/70 px-1.5 py-0.5 font-mono text-[9px] text-white/85 hover:bg-black/90"
          title="Remove from queue"
        >
          ×
        </button>
      </div>
      )}
    </div>
  );
}
