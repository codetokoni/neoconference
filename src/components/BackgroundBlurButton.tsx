"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalParticipant } from "@livekit/components-react";
import { Track, type LocalVideoTrack } from "livekit-client";
import {
  isEffectsSupported,
  getProcessor,
  type BackgroundEffect,
} from "@/lib/backgroundBlur";

const STORAGE_KEY = "neo:bg-effect";
const MANIFEST_URL = "/backgrounds/manifest.json";

type ManifestEntry = {
  id: string;
  label: string;
  url: string;
  thumb?: string;
};

type Manifest = { backgrounds: ManifestEntry[] };

/**
 * BackgroundBlurButton
 *
 * Toolbar control for applying privacy effects to the local camera feed.
 * Despite the legacy name, it now exposes three modes: none, blur, and
 * image (virtual background). The image set is sourced at runtime from
 * /backgrounds/manifest.json so background art can be added without
 * shipping a new bundle.
 *
 * Behavior:
 * - Hidden entirely on browsers without MediaStreamTrackProcessor (Safari).
 * - Selection persisted to localStorage under "neo:bg-effect".
 * - Errors are logged and the effect resets to none — a failed effect
 *   should never break the call.
 */
export default function BackgroundBlurButton() {
  const supported = isEffectsSupported();
  const { localParticipant } = useLocalParticipant();
  const [effect, setEffect] = useState<BackgroundEffect>({ mode: "none" });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [manifest, setManifest] = useState<ManifestEntry[]>([]);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Restore persisted preference on mount.
  useEffect(() => {
    if (!supported) return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as BackgroundEffect;
      if (parsed && typeof parsed === "object" && "mode" in parsed) {
        setEffect(parsed);
      }
    } catch {
      // ignore — corrupted preference, default to none.
    }
  }, [supported]);

  // Load manifest the first time the popover opens.
  useEffect(() => {
    if (!open || manifest.length > 0) return;
    let cancelled = false;
    fetch(MANIFEST_URL, { cache: "force-cache" })
      .then((r) => (r.ok ? r.json() : { backgrounds: [] }))
      .then((data: Manifest) => {
        if (cancelled) return;
        if (Array.isArray(data?.backgrounds)) setManifest(data.backgrounds);
      })
      .catch(() => {
        // Manifest is optional; leave list empty.
      });
    return () => {
      cancelled = true;
    };
  }, [open, manifest.length]);

  // Apply / remove the processor whenever effect or camera track changes.
  useEffect(() => {
    if (!supported || !localParticipant) return;
    let cancelled = false;

    const apply = async () => {
      const pub = localParticipant.getTrackPublication(Track.Source.Camera);
      const track = pub?.videoTrack as LocalVideoTrack | undefined;
      if (!track) return;
      try {
        if (effect.mode === "none") {
          await track.stopProcessor();
        } else {
          const proc = await getProcessor(effect);
          if (cancelled || !proc) return;
          await track.setProcessor(proc as any);
        }
      } catch (e) {
        console.warn("background effect failed", e);
        if (!cancelled) setEffect({ mode: "none" });
      }
    };

    apply();
    return () => {
      cancelled = true;
    };
  }, [effect, supported, localParticipant]);

  // Persist preference.
  useEffect(() => {
    if (!supported) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(effect));
    } catch {
      // ignore
    }
  }, [effect, supported]);

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const choose = useCallback(
    (next: BackgroundEffect) => {
      if (busy) return;
      setBusy(true);
      setEffect(next);
      setOpen(false);
      // Brief debounce so rapid clicks don't fire overlapping setProcessor calls.
      setTimeout(() => setBusy(false), 400);
    },
    [busy]
  );

  // Settings → Video tab can toggle blur on/off via this event.
  useEffect(() => {
    if (!supported) return;
    const onToggle = () => {
      if (busy) return;
      setBusy(true);
      setEffect((prev) => (prev.mode === "none" ? { mode: "blur" } : { mode: "none" }));
      setOpen(false);
      setTimeout(() => setBusy(false), 400);
    };
    window.addEventListener("neoconf:background-blur:toggle", onToggle as EventListener);
    return () => window.removeEventListener("neoconf:background-blur:toggle", onToggle as EventListener);
  }, [supported, busy]);

  if (!supported) return null;

  const isOn = effect.mode !== "none";
  const label =
    effect.mode === "none"
      ? "Effects"
      : effect.mode === "blur"
      ? "Blur"
      : "Background";

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        data-room-chrome="true"
        onClick={() => setOpen((v) => !v)}
        aria-pressed={isOn}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm"
        title="Background effects"
      >
        {label}
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="menu"
          data-room-chrome="true"
          className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-50 w-[280px] rounded-md bg-zinc-900 border border-white/15 shadow-lg p-2"
        >
          <Option
            active={effect.mode === "none"}
            label="None"
            onClick={() => choose({ mode: "none" })}
          />
          <Option
            active={effect.mode === "blur"}
            label="Blur"
            onClick={() => choose({ mode: "blur" })}
          />
          {manifest.length > 0 && (
            <div
              role="radiogroup"
              aria-label="Virtual backgrounds"
              className="mt-2 grid grid-cols-2 gap-2"
            >
              {manifest.map((bg) => (
                <BackgroundTile
                  key={bg.id}
                  bg={bg}
                  active={
                    effect.mode === "image" && effect.url === bg.url
                  }
                  onSelect={() => choose({ mode: "image", url: bg.url })}
                />
              ))}
            </div>
          )}
          {manifest.length === 0 && (
            <p className="mt-2 text-[10px] text-zinc-400 px-1">
              No backgrounds installed yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Option({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      data-room-chrome="true"
      onClick={onClick}
      className={
        "block w-full text-left px-2 py-1.5 text-xs rounded " +
        (active
          ? "bg-white text-black"
          : "text-white hover:bg-white/10")
      }
    >
      {label}
    </button>
  );
}

/**
 * BackgroundTile
 *
 * Polished preview tile for a virtual-background option. Shows an actual
 * <img> (with lazy + async decode), a skeleton shimmer while decoding,
 * a graceful gradient fallback if the asset 404s, a visible label, and a
 * checkmark badge when active. Matches the visual language users expect
 * from Zoom/Meet/Whereby background pickers.
 */
function BackgroundTile({
  bg,
  active,
  onSelect,
}: {
  bg: ManifestEntry;
  active: boolean;
  onSelect: () => void;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const src = bg.thumb ?? bg.url;
  const initial = (bg.label || "?").trim().charAt(0).toUpperCase();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-room-chrome="true"
      onClick={onSelect}
      title={bg.label}
      className={
        "group flex flex-col gap-1 text-left rounded-md p-1 transition " +
        (active
          ? "bg-white/10 ring-2 ring-white"
          : "hover:bg-white/5 ring-1 ring-white/10 hover:ring-white/30")
      }
    >
      <div className="relative w-full aspect-video overflow-hidden rounded bg-zinc-800">
        {status === "loading" && (
          <div
            aria-hidden="true"
            className="absolute inset-0 animate-pulse bg-gradient-to-br from-zinc-700 via-zinc-800 to-zinc-700"
          />
        )}
        {status !== "error" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setStatus("ready")}
            onError={() => setStatus("error")}
            className={
              "absolute inset-0 w-full h-full object-cover transition-opacity " +
              (status === "ready" ? "opacity-100" : "opacity-0")
            }
          />
        )}
        {status === "error" && (
          <div
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-zinc-700 to-zinc-900 text-zinc-300 text-lg font-semibold"
          >
            {initial}
          </div>
        )}
        {active && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 w-4 h-4 rounded-full bg-white text-zinc-900 flex items-center justify-center shadow"
          >
            <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
              <path
                d="M2 6.5l2.5 2.5L10 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        )}
      </div>
      <span
        className={
          "block px-0.5 text-[11px] leading-tight truncate " +
          (active ? "text-white" : "text-zinc-300 group-hover:text-white")
        }
      >
        {bg.label}
      </span>
    </button>
  );
}