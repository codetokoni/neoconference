"use client";

// The moderator handout (/video/room/moderate): a screen first. The live
// broadcast fills the window; a slim bar (room, what is on air, live count)
// and two icon controls fade out when nobody touches anything; boards,
// queues, screens and health sit in a drawer whose sections fold away.
// Same data, links and display modes the moderator hub had — only the
// layout changed.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import SimulcastPlayer from "./SimulcastPlayer";
import HealthStrip from "./HealthStrip";
import { roomLink } from "@/lib/simulcast";

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
  totalSlots: number;
  counts: { live: number; claimedNoCamera: number; neverClaimed: number };
  screenBlocks: ScreenBlock[];
  featured: { streamId: string; label: string; at: number } | null;
}

interface QueueMeta {
  slug: string;
  name: string;
  order: string[];
}

const IDLE_MS = 3000;

function IconButton({
  label,
  shortcut,
  onClick,
  active,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        className={
          "flex h-9 w-9 items-center justify-center rounded-lg border text-white/85 transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 " +
          (active ? "border-emerald-400/60 bg-emerald-500/15" : "border-white/15 bg-black/50")
        }
      >
        {children}
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-10 mt-1.5 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[11px] text-white opacity-0 shadow transition group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {label}
        {shortcut && <kbd className="ml-1.5 rounded border border-white/25 px-1 font-mono text-[10px] text-white/70">{shortcut}</kbd>}
      </span>
    </span>
  );
}

function Section({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="group border-b border-white/10 py-2 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer select-none items-center justify-between py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-white/60 hover:text-white">
        {title}
        <span aria-hidden="true" className="transition group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}

const linkClass =
  "rounded-md border border-white/12 px-2.5 py-1 text-xs text-white/90 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400";

export default function ModeratorDisplay({ room, roomName }: { room: string; roomName: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [queues, setQueues] = useState<QueueMeta[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [visible, setVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overControls = useRef(false);

  /* ---- data: the same endpoints and polling as the moderator hub ---- */
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/video/room/summary?room=${encodeURIComponent(room)}`, { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error === "forbidden" ? "No control-room access." : "Could not load room status.");
        return;
      }
      setErr(null);
      setSummary(j as Summary);
    } catch {
      setErr("Connection lost — retrying…");
    }
    try {
      const qr = await fetch(`/api/video/queues?room=${encodeURIComponent(room)}`, { cache: "no-store" });
      const qj = await qr.json();
      if (qj.ok) setQueues(qj.queues as QueueMeta[]);
    } catch {
      /* the queue list is optional */
    }
  }, [room]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  /* ---- controls fade out when idle ---- */
  const wake = useCallback(() => {
    setVisible(true);
    if (idleRef.current) clearTimeout(idleRef.current);
    idleRef.current = setTimeout(() => {
      if (!overControls.current) setVisible(false);
    }, IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    const events = ["pointermove", "pointerdown", "keydown", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, wake, { passive: true }));
    return () => {
      events.forEach((e) => window.removeEventListener(e, wake));
      if (idleRef.current) clearTimeout(idleRef.current);
    };
  }, [wake]);
  const shown = visible || panelOpen;

  /* ---- fullscreen ---- */
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else rootRef.current?.requestFullscreen?.().catch(() => {});
  }, []);

  /* ---- keys: F fullscreen, P panels, Esc closes the panels ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        setPanelOpen((o) => !o);
      } else if (e.key === "Escape" && panelOpen) {
        setPanelOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFullscreen, panelOpen]);

  const s = summary;
  const display = (path: string, extra: Record<string, string | number | undefined> = {}) =>
    `${path}${roomLink(room, { ...extra, display: 1 })}`;

  return (
    <div
      ref={rootRef}
      className={"fixed inset-0 z-[60] overflow-hidden bg-black text-white " + (shown ? "" : "cursor-none")}
      aria-label={`Moderator display · ${roomName}`}
    >
      <div className="absolute inset-0">
        <SimulcastPlayer room={room} showChat={false} variant="display" />
      </div>

      {/* Top bar: what is on air and how many are live; two controls. */}
      <div
        onPointerEnter={() => (overControls.current = true)}
        onPointerLeave={() => (overControls.current = false)}
        className={
          "absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-3 bg-gradient-to-b from-black/80 via-black/40 to-transparent px-4 pb-8 pt-3 transition-opacity duration-300 " +
          (shown ? "opacity-100" : "pointer-events-none opacity-0")
        }
        // Keep the controls clear of the open drawer.
        style={panelOpen ? { paddingRight: "calc(min(340px, 92vw) + 1rem)" } : undefined}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="truncate text-sm font-semibold">{roomName}</span>
          {s && (
            <span className="inline-flex items-center gap-1.5 rounded bg-white/10 px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-amber-200">
              On air · {s.featured ? s.featured.label : "Programme"}
            </span>
          )}
          {s && (
            <span className="font-mono text-[11px] text-white/75" title="Participants live / slots">
              <b className="text-emerald-300">{s.counts.live}</b>/{s.totalSlots} live
            </span>
          )}
          {err && (
            <span role="alert" className="rounded bg-red-500/20 px-2 py-0.5 text-[11px] text-red-200">
              {err}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <IconButton label={panelOpen ? "Hide panels" : "Boards, queues, screens"} shortcut="P" active={panelOpen} onClick={() => setPanelOpen((o) => !o)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M15 4v16" />
            </svg>
          </IconButton>
          <IconButton label={isFullscreen ? "Exit fullscreen" : "Fullscreen"} shortcut="F" onClick={toggleFullscreen}>
            {isFullscreen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="M9 3v4H5M15 3v4h4M9 21v-4H5M15 21v-4h4" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5" />
              </svg>
            )}
          </IconButton>
        </div>
      </div>

      {/* Optional panels, each section folds away. */}
      {panelOpen && (
        <aside
          aria-label="Moderator panels"
          className="absolute bottom-0 right-0 top-0 z-40 flex w-[min(340px,92vw)] flex-col overflow-y-auto border-l border-white/10 bg-[#0B1218]/95 px-4 pb-6 pt-14 backdrop-blur"
        >
          <button
            type="button"
            onClick={() => setPanelOpen(false)}
            aria-label="Close panels"
            title="Close (Esc)"
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-md border border-white/15 text-white/80 hover:bg-white/10"
          >
            ✕
          </button>

          <Section title="Health" defaultOpen>
            <HealthStrip room={room} />
          </Section>

          <Section title="Boards" defaultOpen>
            <div className="flex flex-wrap gap-2">
              <a href={display("/video/room/cameras")} className={linkClass} title="All live cameras, projection-friendly">
                Camera board
              </a>
              <a href={display("/video/room/names")} className={linkClass} title="Who is here, without video — uses no viewer slots">
                Name board
              </a>
            </div>
          </Section>

          <Section title={`Queues${queues.length ? ` · ${queues.length}` : ""}`}>
            {queues.length === 0 ? (
              <a href={`/video/room/queue${roomLink(room)}`} className="text-xs text-emerald-300 hover:text-emerald-200">
                No queues — create one →
              </a>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {queues.map((q) => (
                  <li key={q.slug}>
                    <a
                      href={display(`/video/room/${encodeURIComponent(q.slug)}`)}
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-white/5"
                      title={`Open ${q.name} (display)`}
                    >
                      <span className="truncate">{q.name}</span>
                      <span className="font-mono text-[11px] text-white/55">{q.order.length} staged</span>
                    </a>
                  </li>
                ))}
                <li>
                  <a href={`/video/room/queue${roomLink(room)}`} className="px-2 text-xs text-emerald-300 hover:text-emerald-200">
                    Manage queues →
                  </a>
                </li>
              </ul>
            )}
          </Section>

          <Section title={`Screens${s ? ` · ${s.screenBlocks.length}` : ""}`}>
            {!s ? (
              <p className="text-xs text-white/50">Loading…</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {s.screenBlocks.map((b) => (
                  <li key={b.screen} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-white/5">
                    <span
                      className="text-sm"
                      title={`Slots ${b.from}–${b.to}: ${b.claimedNoCamera} joined without camera, ${b.neverClaimed} never claimed`}
                    >
                      Screen {b.screen}{" "}
                      <span className="font-mono text-[11px] text-white/55">
                        <b className="text-emerald-300">{b.live}</b>/{b.total}
                      </span>
                    </span>
                    <span className="flex gap-1.5">
                      <a href={display("/video/room/cameras", { screen: b.screen })} className={linkClass} title={`Camera board — screen ${b.screen}`}>
                        Cams
                      </a>
                      <a href={display("/video/room/names", { screen: b.screen })} className={linkClass} title={`Name board — screen ${b.screen}`}>
                        Names
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {s && (
            <p className="pt-3 font-mono text-[11px] text-white/50">
              {s.counts.claimedNoCamera} joined without camera · {s.counts.neverClaimed} never claimed
            </p>
          )}
        </aside>
      )}
    </div>
  );
}
