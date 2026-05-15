"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, Mic, Pencil, Video, X } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";

export type RoomEntryValues = {
  username: string;
  videoEnabled: boolean;
  audioEnabled: boolean;
  videoDeviceId?: string;
  audioDeviceId?: string;
};

const NAME_KEY = "neoconf:displayName";

// Mirrors the server-side regex in /api/events/rename for client-side shortcutting.
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function getSavedDisplayName(): string {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
}
export function saveDisplayName(name: string) {
  try { localStorage.setItem(NAME_KEY, name); } catch {}
}

function humanizeRenameError(code?: string): string {
  switch ((code || "").toLowerCase()) {
    case "slug_taken": return "That URL is already taken. Try another.";
    case "invalid_slug": return "URL can only contain lowercase letters, numbers, and dashes.";
    case "forbidden": return "Only the host can rename this meeting.";
    case "network_error": return "Network error. Check your connection and try again.";
    case "rename_failed": return "Rename failed. Please try again.";
    case "not_found": return "This meeting doesn't exist.";
    default: return code ? `Rename failed (${code}).` : "Rename failed. Please try again.";
  }
}

type Quality = "checking" | "excellent" | "good" | "poor" | "offline";

export function RoomNameEntry({
  roomName,
  defaultName,
  onSubmit,
  onCopyLink,
  copied,
  isHost = false,
  eventSlug,
}: {
  roomName: string;
  defaultName: string;
  onSubmit: (v: RoomEntryValues) => void;
  onCopyLink: () => void;
  copied: boolean;
  isHost?: boolean;
  eventSlug?: string;
}) {
  const [name, setName] = useState(() => getSavedDisplayName() || defaultName);
  const [video, setVideo] = useState(true);
  const [audio, setAudio] = useState(true);
  const [joining, setJoining] = useState(false);
  const [permError, setPermError] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0); // 0..1
  const [quality, setQuality] = useState<Quality>("checking");
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  // Device pickers (camera + mic only — speaker output deferred due to
  // setSinkId being absent/broken in Safari).
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDeviceId, setVideoDeviceId] = useState<string | undefined>(undefined);
  const [audioDeviceId, setAudioDeviceId] = useState<string | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState<"video" | "audio" | null>(null);
  const [devicesUnavailable, setDevicesUnavailable] = useState(false);
  const isMobile = useIsMobile();

  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const pencilRef = useRef<HTMLButtonElement>(null);
  const cameraRowRef = useRef<HTMLDivElement>(null);
  const micRowRef = useRef<HTMLDivElement>(null);

  // --- Enumerate input devices + listen for hot-plug changes ---
  const enumerate = useCallback(async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      setVideoDevices(devs.filter((d) => d.kind === "videoinput"));
      setAudioDevices(devs.filter((d) => d.kind === "audioinput"));
      setDevicesUnavailable(false);
    } catch {
      setDevicesUnavailable(true);
    }
  }, []);

  useEffect(() => {
    enumerate();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = () => { enumerate(); };
    md.addEventListener("devicechange", onChange);
    return () => md.removeEventListener("devicechange", onChange);
  }, [enumerate]);

  useEffect(() => {
    if (!getSavedDisplayName() && defaultName) setName(defaultName);
  }, [defaultName]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // --- Acquire camera + mic stream when toggles change ---
  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setMicLevel(0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function acquire() {
      stopStream();
      if (!video && !audio) return;
      try {
        const videoConstraints: MediaTrackConstraints = {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          ...(videoDeviceId
            ? { deviceId: { ideal: videoDeviceId } }
            : { facingMode: "user" }),
        };
        const audioConstraints: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(audioDeviceId ? { deviceId: { ideal: audioDeviceId } } : {}),
        };
        const stream = await navigator.mediaDevices.getUserMedia({
          video: video ? videoConstraints : false,
          audio: audio ? audioConstraints : false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        setPermError(null);
        // After permission is granted, enumerateDevices() returns real labels;
        // re-run so device pickers can show names instead of "Camera 1".
        enumerate();
        if (video && videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        if (audio) {
          const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          const data = new Uint8Array(analyser.frequencyBinCount);
          const tick = () => {
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
              const v = (data[i] - 128) / 128;
              sum += v * v;
            }
            const rms = Math.sqrt(sum / data.length);
            setMicLevel(Math.min(1, rms * 3));
            rafRef.current = requestAnimationFrame(tick);
          };
          tick();
        }
      } catch (err) {
        const msg = (err as Error)?.message || "Permission denied";
        setPermError(msg);
      }
    }
    acquire();
    return () => { cancelled = true; stopStream(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, audio, videoDeviceId, audioDeviceId]);

  // --- Connection quality probe ---
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const t0 = performance.now();
        const res = await fetch("/favicon.ico?_=" + Date.now(), { cache: "no-store" });
        await res.blob();
        const dt = performance.now() - t0;
        if (cancelled) return;
        setPingMs(Math.round(dt));
        if (dt < 120) setQuality("excellent");
        else if (dt < 300) setQuality("good");
        else setQuality("poor");
      } catch {
        if (!cancelled) setQuality("offline");
      }
    }
    probe();
    const id = setInterval(probe, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (joining) return;
    const trimmed = name.trim() || defaultName || "Guest";
    saveDisplayName(trimmed);
    setJoining(true);
    setTimeout(() => {
      onSubmit({
        username: trimmed,
        videoEnabled: video,
        audioEnabled: audio,
        videoDeviceId,
        audioDeviceId,
      });
    }, 280);
  };

  const qualityMeta: Record<Quality, { label: string; color: string; bars: number }> = {
    checking:  { label: "Checking...",  color: "text-zinc-400",   bars: 0 },
    excellent: { label: "Excellent",    color: "text-emerald-300", bars: 4 },
    good:      { label: "Good",         color: "text-cyan-300",    bars: 3 },
    poor:      { label: "Poor",         color: "text-amber-300",   bars: 2 },
    offline:   { label: "Offline",      color: "text-rose-400",    bars: 1 },
  };
  const qm = qualityMeta[quality];

  return (
    <div className="fixed inset-0 z-30 overflow-hidden bg-[#040713] text-white">
      <div aria-hidden className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-40 -left-40 w-[40rem] h-[40rem] rounded-full bg-cyan-500/20 blur-3xl animate-pulse" />
        <div className="absolute -bottom-40 -right-40 w-[40rem] h-[40rem] rounded-full bg-fuchsia-500/10 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(34,211,238,0.08),transparent_60%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent,rgba(0,0,0,0.4))]" />
      </div>

      <div className="relative h-full w-full overflow-y-auto px-4 py-8 md:py-12">
        <div className="mx-auto max-w-6xl grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-6 lg:gap-10 items-center min-h-[calc(100vh-4rem)]">

          {/* Left: Camera preview */}
          <div className="relative aspect-square sm:aspect-video w-full rounded-3xl overflow-hidden border border-white/10 bg-black shadow-[0_0_80px_rgba(34,211,238,0.18)]">
            {video && !permError && (
              <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover object-top scale-x-[-1]" />
            )}
            {(!video || permError) && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
                <div className="w-24 h-24 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mb-4">
                  <svg viewBox="0 0 24 24" className="w-10 h-10 text-zinc-500" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="text-zinc-300 font-medium">{permError ? "Camera blocked" : "Camera off"}</div>
                <div className="text-xs text-zinc-500 mt-1 max-w-xs">
                  {permError ? "Allow camera access in your browser, or join with camera off." : "Toggle camera on to see your preview."}
                </div>
              </div>
            )}

            <div className="absolute top-3 left-3 right-3 flex items-center justify-between gap-2 pointer-events-none">
              <div className="px-3 py-1 rounded-full bg-black/60 backdrop-blur border border-white/10 text-[11px] uppercase tracking-[0.2em] text-cyan-300 flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${video ? "bg-cyan-400 animate-pulse" : "bg-zinc-600"}`} /> Preview
              </div>
              <div className={`px-3 py-1 rounded-full bg-black/60 backdrop-blur border border-white/10 text-[11px] flex items-center gap-2 ${qm.color}`}>
                <span className="flex items-end gap-0.5 h-3">
                  {[1,2,3,4].map((i) => (
                    <span key={i} className={`w-0.5 rounded-sm ${i <= qm.bars ? "bg-current" : "bg-current/20"}`} style={{ height: `${i*25}%` }} />
                  ))}
                </span>
                <span className="font-medium">{qm.label}{pingMs != null && quality !== "offline" ? ` · ${pingMs}ms` : ""}</span>
              </div>
            </div>
          </div>
          {/* Right: Controls panel */}
          <form onSubmit={submit} className="w-full rounded-3xl border border-cyan-400/20 bg-zinc-950/60 backdrop-blur-xl shadow-[0_0_60px_rgba(34,211,238,0.15)] p-6 md:p-8">
            <div className="flex items-start justify-between gap-3 mb-6">
              <div className="min-w-0 relative">
                <div className="text-[10px] uppercase tracking-[0.35em] text-cyan-400/80">You’re joining</div>
                <div className="flex items-center gap-2 mt-1">
                  <div className="text-2xl md:text-3xl font-bold text-white truncate min-w-0">{roomName}</div>
                  {isHost && eventSlug && (
                    <button
                      ref={pencilRef}
                      type="button"
                      onClick={() => setRenameOpen((x) => !x)}
                      aria-label="Rename room URL"
                      aria-expanded={renameOpen}
                      className="shrink-0 w-6 h-6 rounded-full bg-white/5 border-[0.5px] border-white/10 hover:bg-white/10 hover:border-cyan-400/30 transition flex items-center justify-center"
                    >
                      <Pencil className="w-3.5 h-3.5 text-zinc-300" />
                    </button>
                  )}
                </div>
                <AnimatePresence>
                  {renameOpen && isHost && eventSlug && (
                    <RenameUrlPopover
                      currentSlug={eventSlug}
                      onClose={() => setRenameOpen(false)}
                      anchorRef={pencilRef}
                    />
                  )}
                </AnimatePresence>
              </div>
              <button type="button" onClick={onCopyLink} className="shrink-0 text-[11px] px-3 py-1.5 rounded-full border border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/10 transition">
                {copied ? "Copied!" : "Copy link"}
              </button>
            </div>

            <label className="block text-[11px] uppercase tracking-[0.25em] text-cyan-400/70 mb-2">Display name</label>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              className="w-full px-4 py-3 mb-5 rounded-xl bg-black/60 border border-white/10 focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-400/30 text-lg placeholder:text-zinc-500 transition"
            />

            {/* Mic level meter */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] uppercase tracking-[0.25em] text-cyan-400/70">Mic input</span>
                <span className="text-[11px] text-zinc-500">{audio ? (micLevel > 0.04 ? "Speaking" : "Silent") : "Off"}</span>
              </div>
              <div className="h-2 rounded-full bg-white/5 overflow-hidden border border-white/5">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-cyan-300 to-emerald-300 transition-[width] duration-100"
                  style={{ width: `${audio ? Math.round(micLevel * 100) : 0}%` }}
                />
              </div>
            </div>

            {/* Device pickers */}
            <div className="flex flex-col gap-3 mb-5">
              <DeviceRow
                rowRef={cameraRowRef}
                kind="video"
                label="Camera"
                selectedLabel={labelForSelected(videoDevices, videoDeviceId, "Camera")}
                onOpen={() => setPickerOpen(pickerOpen === "video" ? null : "video")}
                disabled={devicesUnavailable}
              >
                <AnimatePresence>
                  {pickerOpen === "video" && (
                    <DevicePicker
                      kind="video"
                      devices={videoDevices}
                      selectedId={videoDeviceId}
                      isMobile={isMobile}
                      onSelect={(id) => { setVideoDeviceId(id); setPickerOpen(null); }}
                      onClose={() => setPickerOpen(null)}
                    />
                  )}
                </AnimatePresence>
              </DeviceRow>
              <DeviceRow
                rowRef={micRowRef}
                kind="audio"
                label="Microphone"
                selectedLabel={labelForSelected(audioDevices, audioDeviceId, "Microphone")}
                onOpen={() => setPickerOpen(pickerOpen === "audio" ? null : "audio")}
                disabled={devicesUnavailable}
              >
                <AnimatePresence>
                  {pickerOpen === "audio" && (
                    <DevicePicker
                      kind="audio"
                      devices={audioDevices}
                      selectedId={audioDeviceId}
                      isMobile={isMobile}
                      onSelect={(id) => { setAudioDeviceId(id); setPickerOpen(null); }}
                      onClose={() => setPickerOpen(null)}
                    />
                  )}
                </AnimatePresence>
              </DeviceRow>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-7">
              <ToggleTile label="Camera"     on={video} onChange={setVideo} kind="video" />
              <ToggleTile label="Microphone" on={audio} onChange={setAudio} kind="mic" />
            </div>

            <button
              type="submit"
              disabled={joining}
              className={`group w-full py-3.5 rounded-xl font-bold text-lg tracking-wide transition active:scale-[0.99] ${joining ? "bg-cyan-400/40 text-black/70 cursor-not-allowed" : "bg-gradient-to-r from-cyan-400 to-cyan-500 hover:from-cyan-300 hover:to-cyan-400 text-black shadow-[0_0_30px_rgba(34,211,238,0.45)]"}`}
            >
              {joining ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <span className="w-4 h-4 rounded-full border-2 border-black/40 border-t-black animate-spin" />
                  Joining...
                </span>
              ) : (
                <span className="inline-flex items-center justify-center gap-2">Join Room <span className="transition group-hover:translate-x-1">→</span></span>
              )}
            </button>

            <p className="text-center text-[11px] text-zinc-500 mt-4">
              {permError ? "Permissions blocked. You can still join with mic & camera off." : "Your name is saved for future sessions."}
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}

function ToggleTile({ label, on, onChange, kind }: { label: string; on: boolean; onChange: (v: boolean) => void; kind: "video" | "mic" }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={`group flex items-center justify-between gap-3 px-4 py-3 rounded-xl border transition ${on ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200 shadow-[0_0_20px_rgba(34,211,238,0.2)]" : "border-white/10 bg-black/40 text-zinc-400 hover:text-zinc-200"}`}
    >
      <span className="flex items-center gap-2">
        {kind === "video" ? (
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7">
            {on ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M9 6h4a2 2 0 012 2v1m4 0l3-1.5v9l-6-3M5 8a2 2 0 00-2 2v6a2 2 0 002 2h7" />
            )}
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7">
            {on ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v3m-4 0h8M5 11a7 7 0 0014 0M12 14a3 3 0 01-3-3V6a3 3 0 016 0v5a3 3 0 01-3 3z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M9 9v2a3 3 0 005.12 2.12M15 11V6a3 3 0 00-5.83-1M5 11a7 7 0 001.17 3.86M19 11a6.97 6.97 0 01-1.62 4.5M12 18v3m-4 0h8" />
            )}
          </svg>
        )}
        <span className="text-sm font-medium">{label}</span>
      </span>
      <span className={`relative w-9 h-5 rounded-full transition ${on ? "bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.6)]" : "bg-white/10"}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

function labelForSelected(
  devices: MediaDeviceInfo[],
  selectedId: string | undefined,
  fallbackPrefix: string,
): string {
  if (devices.length === 0) return "System default";
  if (!selectedId) return devices[0]?.label || `${fallbackPrefix} 1`;
  const idx = devices.findIndex((d) => d.deviceId === selectedId);
  if (idx === -1) return "System default";
  return devices[idx].label || `${fallbackPrefix} ${idx + 1}`;
}

function DeviceRow({
  rowRef,
  kind,
  label,
  selectedLabel,
  onOpen,
  disabled,
  children,
}: {
  rowRef: React.RefObject<HTMLDivElement | null>;
  kind: "video" | "audio";
  label: string;
  selectedLabel: string;
  onOpen: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const Icon = kind === "video" ? Video : Mic;
  const a11y = kind === "video" ? "Choose camera" : "Choose microphone";
  return (
    <div ref={rowRef} className="relative">
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        aria-label={a11y}
        title={disabled ? "Devices unavailable on insecure origin" : undefined}
        className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-white/[0.04] border-[0.5px] border-white/[0.08] hover:bg-white/[0.06] disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        <span className="flex items-center gap-3 min-w-0">
          <Icon className="w-4 h-4 text-zinc-400 shrink-0" />
          <span className="flex flex-col items-start min-w-0">
            <span className="text-[10px] uppercase tracking-wide text-zinc-400">{label}</span>
            <span className="text-sm text-zinc-200 truncate max-w-[220px] md:max-w-[260px]">
              {selectedLabel}
            </span>
          </span>
        </span>
        <ChevronDown className="w-4 h-4 text-zinc-400 shrink-0" />
      </button>
      {children}
    </div>
  );
}

function DevicePicker({
  kind,
  devices,
  selectedId,
  isMobile,
  onSelect,
  onClose,
}: {
  kind: "video" | "audio";
  devices: MediaDeviceInfo[];
  selectedId?: string;
  isMobile: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Desktop only: outside-tap closes. Mobile uses the backdrop overlay.
  useEffect(() => {
    if (isMobile) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [isMobile, onClose]);

  const title = kind === "video" ? "Choose camera" : "Choose microphone";
  const fallbackPrefix = kind === "video" ? "Camera" : "Microphone";

  const items = devices.map((d, i) => (
    <button
      key={d.deviceId || `idx-${i}`}
      type="button"
      onClick={() => onSelect(d.deviceId)}
      className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg hover:bg-white/5 transition"
    >
      <span className="text-sm text-zinc-200 truncate text-left min-w-0">
        {d.label || `${fallbackPrefix} ${i + 1}`}
      </span>
      {selectedId === d.deviceId && (
        <Check className="w-4 h-4 text-cyan-400 shrink-0" />
      )}
    </button>
  ));

  if (isMobile) {
    return (
      <>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-40 bg-black/50"
          onClick={onClose}
          aria-hidden
        />
        <motion.div
          ref={containerRef}
          role="dialog"
          aria-label={title}
          initial={reduced ? { opacity: 0 } : { y: "100%" }}
          animate={reduced ? { opacity: 1 } : { y: 0 }}
          exit={reduced ? { opacity: 0 } : { y: "100%" }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="fixed left-0 right-0 bottom-0 z-50 rounded-t-2xl p-4 max-h-[60vh] overflow-y-auto"
          style={{
            background: "rgba(0,0,0,0.95)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            paddingBottom: "calc(1rem + env(safe-area-inset-bottom))",
          }}
        >
          <div className="flex justify-center mb-3">
            <div className="w-10 h-1 rounded-full bg-white/20" />
          </div>
          <div className="flex items-center justify-between mb-3">
            <div className="w-7" />
            <div className="text-sm font-medium text-white">{title}</div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition"
            >
              <X className="w-4 h-4 text-zinc-300" />
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {items.length > 0 ? items : (
              <div className="text-center text-zinc-500 text-sm py-6">
                No devices found
              </div>
            )}
          </div>
        </motion.div>
      </>
    );
  }

  // Desktop popover
  return (
    <motion.div
      ref={containerRef}
      role="dialog"
      aria-label={title}
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="absolute left-0 right-0 top-full mt-2 z-40 max-h-64 overflow-y-auto rounded-xl p-1"
      style={{
        background: "rgba(0,0,0,0.9)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        border: "0.5px solid rgba(255,255,255,0.12)",
        transformOrigin: "top",
      }}
    >
      {items.length > 0 ? items : (
        <div className="text-center text-zinc-500 text-sm py-3">
          No devices found
        </div>
      )}
    </motion.div>
  );
}

function RenameUrlPopover({
  currentSlug,
  onClose,
  anchorRef,
}: {
  currentSlug: string;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(currentSlug);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input + select all on open; restore focus to pencil on close.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const anchor = anchorRef.current;
    return () => { anchor?.focus(); };
  }, [anchorRef]);

  // Outside-tap and Escape close the popover.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return; // pencil toggles itself
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [onClose, anchorRef]);

  const trimmed = value.trim().toLowerCase();
  const sameAsCurrent = trimmed === currentSlug.toLowerCase();
  const formatValid = SLUG_REGEX.test(trimmed);
  const formatError = trimmed.length > 0 && !formatValid
    ? humanizeRenameError("invalid_slug")
    : null;
  const canSave = formatValid && !sameAsCurrent && !busy;
  const displayError = err || formatError;

  const submit = useCallback(async () => {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/events/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: currentSlug, newSlug: trimmed }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; roomUrl?: string };
      if (!res.ok || !j.ok || !j.roomUrl) {
        setErr(humanizeRenameError(j.error));
        setBusy(false);
        return;
      }
      // Full reload re-derives roomName/eventSlug/role from the new URL.
      window.location.href = j.roomUrl;
    } catch {
      setErr(humanizeRenameError("network_error"));
      setBusy(false);
    }
  }, [canSave, currentSlug, trimmed]);

  return (
    <motion.div
      ref={popoverRef}
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      role="dialog"
      aria-label="Rename room URL"
      className="absolute left-0 top-full mt-2 z-30 min-w-[260px] rounded-xl p-3"
      style={{
        background: "rgba(0,0,0,0.85)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        border: "0.5px solid rgba(34,211,238,0.3)",
        transformOrigin: "top left",
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && canSave) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1.5">
        Rename URL
      </div>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => { setValue(e.target.value); setErr(null); }}
        maxLength={64}
        placeholder="lowercase, numbers, dashes"
        disabled={busy}
        className="w-full px-3 py-2 rounded-lg bg-black/60 border border-white/10 focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-400/30 text-sm text-white placeholder:text-zinc-500"
      />
      {displayError && (
        <div className="text-xs text-red-400 mt-2">{displayError}</div>
      )}
      <div className="flex justify-end gap-2 mt-3">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="text-sm text-zinc-400 hover:text-zinc-200 px-2 py-1 transition"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSave}
          className="bg-cyan-500 hover:bg-cyan-400 disabled:bg-cyan-500/30 disabled:cursor-not-allowed rounded-md px-3 py-1.5 text-sm font-medium text-black transition"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </motion.div>
  );
}

export default RoomNameEntry;
