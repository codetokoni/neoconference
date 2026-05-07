"use client";
import { useEffect, useRef, useState, useCallback } from "react";

export type RoomEntryValues = {
  username: string;
  videoEnabled: boolean;
  audioEnabled: boolean;
};

const NAME_KEY = "neoconf:displayName";

export function getSavedDisplayName(): string {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
}
export function saveDisplayName(name: string) {
  try { localStorage.setItem(NAME_KEY, name); } catch {}
}

type Quality = "checking" | "excellent" | "good" | "poor" | "offline";

export function RoomNameEntry({
  roomName,
  defaultName,
  onSubmit,
  onCopyLink,
  copied,
}: {
  roomName: string;
  defaultName: string;
  onSubmit: (v: RoomEntryValues) => void;
  onCopyLink: () => void;
  copied: boolean;
}) {
  const [name, setName] = useState(() => getSavedDisplayName() || defaultName);
  const [video, setVideo] = useState(true);
  const [audio, setAudio] = useState(true);
  const [joining, setJoining] = useState(false);
  const [permError, setPermError] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0); // 0..1
  const [quality, setQuality] = useState<Quality>("checking");
  const [pingMs, setPingMs] = useState<number | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

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
        const stream = await navigator.mediaDevices.getUserMedia({
          video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
          audio: audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        setPermError(null);
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
  }, [video, audio]);

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
      onSubmit({ username: trimmed, videoEnabled: video, audioEnabled: audio });
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
          <div className="relative aspect-video w-full rounded-3xl overflow-hidden border border-white/10 bg-black shadow-[0_0_80px_rgba(34,211,238,0.18)]">
            {video && !permError && (
              <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover scale-x-[-1]" />
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
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.35em] text-cyan-400/80">You\u2019re joining</div>
                <div className="text-2xl md:text-3xl font-bold text-white truncate mt-1">{roomName}</div>
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
                <span className="inline-flex items-center justify-center gap-2">Join Room <span className="transition group-hover:translate-x-1">\u2192</span></span>
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

export default RoomNameEntry;
