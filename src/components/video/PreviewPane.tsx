"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAmsMultitrack } from "./useAmsMultitrack";

export interface PreviewState {
  streamId: string;
  label: string;
  at: number;
}

/**
 * Preview slot on the cameras board.
 *
 * Costs one extra WebRTC subscription — the whole point of a preview pane
 * is that the operator has audio and full-quality video for the person
 * they are about to cut to, without the audience seeing them yet. The
 * subscription is only open while `preview` is set.
 *
 * State is server-side (see /api/video/preview) so multiple operators
 * agree on what is in Preview at once. This component just renders it
 * and offers the Take-to-air / Clear controls.
 */
export default function PreviewPane({
  preview,
  onTake,
  onClear,
  busy,
}: {
  preview: PreviewState | null;
  onTake: (p: PreviewState) => void;
  onClear: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const streamId = preview?.streamId ?? "";
  const { videoStream } = useAmsMultitrack(streamId, Boolean(streamId));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (videoStream && el.srcObject !== videoStream) {
      el.srcObject = videoStream;
      el.play().catch(() => {});
    }
    if (!videoStream) el.srcObject = null;
  }, [videoStream]);

  const take = useCallback(() => {
    if (preview) onTake(preview);
  }, [preview, onTake]);

  if (!preview) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-white/12 bg-[#101820] p-3 text-sm text-white/60">
        <span className="rounded-sm border border-white/15 bg-black/60 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-white/70">
          Preview
        </span>
        <span>
          Click a tile then <b className="text-white">Send to preview</b> to check camera and
          audio before you cut to air.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-400/40 bg-emerald-500/[0.06] p-3">
      <div className="relative h-[108px] w-[192px] flex-none overflow-hidden rounded-md border border-white/15 bg-black">
        <video ref={ref} playsInline autoPlay className="h-full w-full object-cover" />
        <span className="absolute left-1 top-1 rounded-sm bg-emerald-500 px-1 font-mono text-[8px] uppercase tracking-[0.1em] text-black">
          Preview
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
          Ready to take
        </span>
        <span className="truncate text-lg font-semibold text-white">{preview.label}</span>
        <span className="truncate font-mono text-[10px] text-white/45">{preview.streamId}</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={take}
          disabled={busy}
          className="rounded-md bg-amber-500 px-4 py-2 text-sm font-semibold text-[#14100a] hover:bg-amber-400 disabled:opacity-40"
        >
          Take to air
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          className="rounded-md border border-white/15 px-3 py-2 text-sm text-white/85 hover:bg-white/10 disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
