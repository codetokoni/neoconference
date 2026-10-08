"use client";

import { useMemo } from "react";
import { splitMachineChannels, type SimulcastChannel } from "@/lib/simulcast";

export default function ChannelRail({
  channels,
  more = [],
  live,
  active,
  onSelect,
}: {
  channels: SimulcastChannel[];
  /** Languages without a booth, captioned by the translation worker. A
   *  hundred-odd of them: the most picked get buttons, the rest a list. */
  more?: SimulcastChannel[];
  live: Set<string>;
  active: string;
  onSelect: (id: string) => void;
}) {
  const liveCount = channels.filter((c) => live.has(c.id)).length;
  const { top, rest } = useMemo(() => splitMachineChannels(more), [more]);
  const restActive = rest.find((c) => c.id === active);

  /** One channel's button. `sub` is the small line under its name. */
  const button = (c: SimulcastChannel, name: string, sub: string) => {
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
          <b className={on ? "text-white" : "text-white/80"}>{name}</b>
          <small className="truncate font-mono text-[10px] text-white/40" lang={c.machine ? c.lang : undefined}>
            {sub}
            {!isLive && " · offline"}
          </small>
        </span>
      </button>
    );
  };

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
        {channels.map((c) => button(c, c.label, c.id))}
      </div>

      {more.length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
            More languages · machine translated
          </span>

          {top.length > 0 && (
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(138px,1fr))]">
              {top.map((c) => {
                // "German · Deutsch": the English name on the button, the
                // language's own name under it.
                const [name, native] = c.label.split(" · ");
                return button(c, name, native ?? c.code);
              })}
            </div>
          )}

          {rest.length > 0 && (
            <select
              aria-label="More languages"
              value={restActive ? restActive.id : ""}
              onChange={(e) => e.target.value && onSelect(e.target.value)}
              style={restActive ? { borderColor: restActive.color } : undefined}
              className="w-full rounded-lg border border-white/10 bg-[#0B1319] px-3 py-2.5 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 [&>option]:bg-[#0B1319]"
            >
              <option value="">
                {top.length > 0 ? `${rest.length} more languages…` : `Choose from ${rest.length} languages…`}
              </option>
              {rest.map((c) => (
                <option key={c.id} value={c.id} lang={c.lang}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}
