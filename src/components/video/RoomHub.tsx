"use client";

import { useCallback, useEffect, useState } from "react";

interface ScreenBlock {
  screen: number;
  from: number;
  to: number;
  total: number;
  live: number;
  claimedNoCamera: number;
  neverClaimed: number;
}

interface Summary {
  ok: true;
  room: string;
  mainTrack: string;
  totalSlots: number;
  codePrefix: string;
  counts: {
    live: number;
    claimedNoCamera: number;
    neverClaimed: number;
  };
  screens: number;
  perScreen: number;
  screenBlocks: ScreenBlock[];
  featured: { streamId: string; label: string; at: number } | null;
}

/**
 * Hub for the control room. Deliberately renders no video — its job is to
 * point the producer at the right board on the right screen and show the
 * numbers that decide whether doors can open. Polls the summary endpoint
 * every few seconds; the boards themselves each own their own connection.
 */
export default function RoomHub({ room }: { room: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState("");

  useEffect(() => {
    setJoinUrl(`${window.location.origin}/video/join`);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/video/room/summary?room=${encodeURIComponent(room)}`, {
        cache: "no-store",
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error === "forbidden" ? "You do not have control-room access." : "Could not load.");
        return;
      }
      setErr(null);
      setSummary(j as Summary);
    } catch {
      /* transient */
    }
  }, [room]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (err) return <p className="text-sm text-red-400">{err}</p>;
  if (!summary) {
    return (
      <p className="font-mono text-xs uppercase tracking-[0.14em] text-white/45">
        Loading…
      </p>
    );
  }

  const s = summary;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 rounded-xl border border-white/12 bg-[#141C22] p-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-amber-300/90">
            On air
          </span>
          <span className="text-xl font-bold text-white">
            {s.featured ? s.featured.label : "Programme feed"}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-4 lg:min-w-[360px]">
          <Stat value={s.counts.live} total={s.totalSlots} label="live" tone="emerald" />
          <Stat value={s.counts.claimedNoCamera} label="joined, no camera" tone="amber" />
          <Stat value={s.counts.neverClaimed} label="never claimed" tone="muted" />
        </div>
      </div>

      <div className="grid gap-3 rounded-xl border border-white/12 bg-[#141C22] p-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
            Join link
          </span>
          <Copyable value={joinUrl || "/video/join"} label="join link" />
          <p className="text-xs text-white/60">
            Send this to participants. They enter their code to claim their tile.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
            Code prefix
          </span>
          <Copyable
            value={
              s.codePrefix
                ? `${s.codePrefix}-01..${String(s.totalSlots).padStart(2, "0")}`
                : ""
            }
            label="code prefix"
          />
          <p className="text-xs text-white/60">
            {s.totalSlots} personal codes. Each participant gets one, e.g.{" "}
            {s.codePrefix || "PREFX"}-07.
          </p>
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
          Boards
        </h2>
        <div className="grid gap-3 md:grid-cols-3">
          <BoardCard
            href={`/video/room/cameras?room=${encodeURIComponent(s.room)}&screen=1`}
            title="Camera board"
            subtitle="Grid of live cameras — drag, hide, feature to air."
            costHint="One viewer slot per live camera on this screen."
          />
          <BoardCard
            href={`/video/room/names?room=${encodeURIComponent(s.room)}&screen=1`}
            title="Name board"
            subtitle="Who is here and who is not, without the video."
            costHint="Zero viewer slots used. Poll only."
            cheap
          />
          <BoardCard
            href="#"
            title="Queue"
            subtitle="Stage who goes on air next. Coming next."
            costHint=""
            disabled
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
          Screens
        </h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {s.screenBlocks.map((b) => (
            <ScreenCard key={b.screen} room={s.room} block={b} />
          ))}
        </div>
      </section>
    </div>
  );
}

function Stat({
  value,
  total,
  label,
  tone,
}: {
  value: number;
  total?: number;
  label: string;
  tone: "emerald" | "amber" | "muted";
}) {
  const colour =
    tone === "emerald"
      ? "text-emerald-300"
      : tone === "amber"
        ? "text-amber-300"
        : "text-white/70";
  return (
    <div className="flex flex-col gap-0.5">
      <span className={"text-2xl font-bold " + colour}>
        {value}
        {typeof total === "number" && (
          <span className="text-sm text-white/45"> / {total}</span>
        )}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
        {label}
      </span>
    </div>
  );
}

function BoardCard({
  href,
  title,
  subtitle,
  costHint,
  disabled,
  cheap,
}: {
  href: string;
  title: string;
  subtitle: string;
  costHint: string;
  disabled?: boolean;
  cheap?: boolean;
}) {
  const inner = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        {cheap && (
          <span className="rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-emerald-300">
            free
          </span>
        )}
        {disabled && (
          <span className="rounded-sm border border-white/12 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-white/45">
            soon
          </span>
        )}
      </div>
      <p className="text-sm text-white/60">{subtitle}</p>
      {costHint && (
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
          {costHint}
        </p>
      )}
    </>
  );

  const classes =
    "flex flex-col gap-1.5 rounded-lg border border-white/12 bg-[#101820] p-4 transition";

  if (disabled) return <div className={classes + " opacity-50"}>{inner}</div>;
  return (
    <a href={href} className={classes + " hover:border-white/25 hover:bg-white/[0.04]"}>
      {inner}
    </a>
  );
}

function ScreenCard({ room, block }: { room: string; block: ScreenBlock }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-white/12 bg-[#101820] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
            Screen {block.screen}
          </span>
          <span className="text-sm font-semibold text-white">
            Participants {block.from} to {block.to}
          </span>
        </div>
        <div className="flex flex-col items-end leading-tight">
          <span className="text-lg font-bold text-emerald-300">
            {block.live}
            <span className="text-sm text-white/45">/{block.total}</span>
          </span>
          <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/45">
            live
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-md border border-white/10 bg-black/30 p-2 text-[11px]">
        <span className="text-amber-300/90">
          <b>{block.claimedNoCamera}</b>{" "}
          <span className="text-white/45">joined, no camera</span>
        </span>
        <span className="text-white/60">
          <b>{block.neverClaimed}</b>{" "}
          <span className="text-white/45">never claimed</span>
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <a
          href={`/video/room/cameras?room=${encodeURIComponent(room)}&screen=${block.screen}`}
          className="rounded-md border border-white/12 px-3 py-1.5 text-xs text-white hover:bg-white/10"
        >
          Camera board
        </a>
        <a
          href={`/video/room/names?room=${encodeURIComponent(room)}&screen=${block.screen}`}
          className="rounded-md border border-white/12 px-3 py-1.5 text-xs text-white hover:bg-white/10"
        >
          Name board
        </a>
      </div>
    </div>
  );
}

function Copyable({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-2 rounded-md border border-white/12 bg-[#0B1319] px-3 py-1.5 font-mono text-xs text-white hover:bg-white/10"
      aria-label={`Copy ${label}`}
    >
      <span className="truncate">{value || "—"}</span>
      <span className="font-sans text-[10px] uppercase tracking-[0.14em] text-white/60">
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}
