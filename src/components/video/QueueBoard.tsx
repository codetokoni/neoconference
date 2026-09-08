"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAmsMultitrack } from "./useAmsMultitrack";

interface Participant {
  slot: number;
  name: string;
  code: string;
  streamId: string;
  live: boolean;
  claimed: boolean;
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
export default function QueueBoard({ room, slug }: { room: string; slug: string }) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addInput, setAddInput] = useState("");

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
      const raw = addInput.trim();
      if (!raw) return;

      let target: Participant | undefined;
      const asSlot = Number(raw);
      if (Number.isFinite(asSlot) && asSlot > 0) {
        target = participants.find((p) => p.slot === asSlot);
      }
      if (!target) {
        const upper = raw.toUpperCase();
        target = participants.find((p) => p.code.toUpperCase() === upper);
      }
      if (!target) {
        setErr(`No participant matches "${raw}".`);
        return;
      }
      if (queue.order.includes(target.streamId)) {
        setErr(`${target.name} is already queued.`);
        return;
      }
      setErr(null);
      await patchOrder([...queue.order, target.streamId]);
      setAddInput("");
    },
    [addInput, participants, queue, patchOrder],
  );

  const takeToAir = useCallback(
    async (streamId: string, label: string) => {
      if (!queue) return;
      setBusy(true);
      try {
        await fetch(`/api/video/feature?room=${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ streamId, label }),
        });
        // Broadcast convention: after a Take, drop from queue. Producer can
        // re-queue the entry if they want to bring them back.
        await patchOrder(queue.order.filter((s) => s !== streamId));
      } finally {
        setBusy(false);
      }
    },
    [room, queue, patchOrder],
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
    window.location.href = `/video/room/queue?room=${encodeURIComponent(room)}`;
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
            Add participant — slot number or code
          </span>
          <input
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            maxLength={16}
            placeholder="e.g. 7  or  528401"
            className="w-full rounded-md border border-white/12 bg-[#0B1319] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:ring-2 focus:ring-emerald-500"
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

      {queue.order.length === 0 ? (
        <p className="rounded-lg border border-white/12 bg-[#101820] p-4 text-sm text-white/60">
          No entries yet. Add participants by slot number or code above.
        </p>
      ) : (
        <div className="rounded-xl border border-white/12 bg-[#0F1519] p-3">
          <div className="grid grid-cols-4 gap-[6px] sm:grid-cols-6 lg:grid-cols-10">
            {queue.order.map((sid, i) => (
              <QueueTile
                key={sid}
                streamId={sid}
                participant={bySid.get(sid)}
                position={i + 1}
                first={i === 0}
                last={i === queue.order.length - 1}
                busy={busy}
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
    </div>
  );
}

/**
 * One tile in the queue grid. Same shape as the Camera board's tile
 * (aspect-4/3, slot number top-left, name bottom, video for live
 * participants) so a producer flipping between the two boards reads
 * the layout instantly.
 *
 * The whole tile is clickable to take-to-air — matches the "one click
 * to feature" language on the hub. Hover actions add preview / remove
 * / reorder without cluttering the tile at rest.
 */
function QueueTile({
  streamId,
  participant,
  position,
  first,
  last,
  busy,
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
      onClick={busy ? undefined : onTake}
      className={
        "group relative aspect-[4/3] cursor-pointer overflow-hidden rounded border bg-[#16232B] " +
        (first
          ? "border-amber-400 ring-1 ring-amber-400"
          : participant?.live
            ? "border-emerald-500/40"
            : "border-white/10")
      }
      title={
        participant
          ? `Position ${position} — ${participant.name}. Click to take to air.`
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

      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/90 to-transparent px-1.5 py-0.5 text-[10px] font-semibold text-white/90">
        {participant?.name ?? streamId}
      </span>

      {/* Hover controls — appear only on hover so a resting tile looks
          like a Camera board tile. stopPropagation on each so clicking
          them doesn't also trigger the tile's take-to-air. */}
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
    </div>
  );
}
