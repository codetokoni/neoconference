"use client";

import type { SimulcastChannel } from "@/lib/simulcast";

export default function ChannelRail({
  channels,
  live,
  active,
  onSelect,
}: {
  channels: SimulcastChannel[];
  live: Set<string>;
  active: string;
  onSelect: (id: string) => void;
}) {
  const liveCount = channels.filter((c) => live.has(c.id)).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
          Audio channel
        </span>
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/35">
          {liveCount} live · {channels.length - liveCount} offline
        </span>
      </div>

      <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(138px,1fr))]">
        {channels.map((c) => {
          const isLive = live.has(c.id);
          const on = active === c.id;
          return (
            <button
              key={c.id}
              type="button"
              disabled={!isLive}
              aria-pressed={on}
              onClick={() => isLive && onSelect(c.id)}
              style={on ? { borderColor: c.color, background: "rgba(255,255,255,0.06)" } : undefined}
              className={[
                "flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left transition",
                isLive ? "hover:border-white/25 hover:bg-white/[0.06]" : "cursor-not-allowed opacity-40",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400",
              ].join(" ")}
            >
              <span className="h-6 w-2 flex-none rounded-sm" style={{ background: c.color }} />
              <span className="flex min-w-0 flex-col leading-tight">
                <b className={on ? "text-white" : "text-white/80"}>{c.label}</b>
                <small className="truncate font-mono text-[10px] text-white/40">
                  {c.id}
                  {!isLive && " · offline"}
                </small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
