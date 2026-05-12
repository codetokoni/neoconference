"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import MicLevelMeter from "./MicLevelMeter";
import SpeakerTestButton from "./SpeakerTestButton";

export type RoomEntryValues = {
  username: string;
  videoEnabled: boolean;
  audioEnabled: boolean;
  videoDeviceId?: string;
  audioDeviceId?: string;
  audioOutputDeviceId?: string;
};

const NAME_KEY = "neoconf:displayName";
const VIDEO_DEV_KEY = "neoconf:device:videoId";
const AUDIO_DEV_KEY = "neoconf:device:audioId";
const AUDIO_OUT_KEY = "neoconf:device:audioOutId";

export function getSavedDisplayName(): string {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
}
export function saveDisplayName(name: string) {
  try { localStorage.setItem(NAME_KEY, name); } catch {}
}

function readDeviceId(key: string): string {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}
function writeDeviceId(key: string, id: string) {
  try { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key); } catch {}
}
function readAudioPref(key: string, fallback: boolean): boolean {
try { const v = localStorage.getItem(key); return v == null ? fallback : v === "1"; } catch { return fallback; }
}

type Quality = "checking" | "excellent" | "good" | "poor" | "offline";

type DeviceInfo = { deviceId: string; label: string; kind: MediaDeviceKind };

function supportsSetSinkId(): boolean {
  if (typeof window === "undefined") return false;
  try { return typeof (HTMLAudioElement.prototype as any).setSinkId === "function"; } catch { return false; }
}

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

  // Device lists + selection
  const [cameras, setCameras] = useState<DeviceInfo[]>([]);
  const [mics, setMics] = useState<DeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<DeviceInfo[]>([]);
  const [videoDeviceId, setVideoDeviceId] = useState<string>(() => readDeviceId(VIDEO_DEV_KEY));
  const [audioDeviceId, setAudioDeviceId] = useState<string>(() => readDeviceId(AUDIO_DEV_KEY));
  const [audioOutputDeviceId, setAudioOutputDeviceId] = useState<string>(() => readDeviceId(AUDIO_OUT_KEY));
  const [acquiring, setAcquiring] = useState(false);
  const [ns, setNs] = useState<boolean>(() => readAudioPref("neoconf:audio:noiseSuppression", true));
  const [ec, setEc] = useState<boolean>(() => readAudioPref("neoconf:audio:echoCancellation", true));
  const [agc, setAgc] = useState<boolean>(() => readAudioPref("neoconf:audio:autoGainControl", true));
  const [toast, setToast] = useState<string | null>(null);
  const canSetSink = supportsSetSinkId();

  // Mic test (record-and-playback)
  const [micTesting, setMicTesting] = useState<"idle" | "recording" | "playing">("idle");
  const [micTestProgress, setMicTestProgress] = useState(0);
  const micRecorderRef = useRef<MediaRecorder | null>(null);
  const micTestChunksRef = useRef<Blob[]>([]);
  const micTestTimerRef = useRef<number | null>(null);
  const micTestAudioRef = useRef<HTMLAudioElement | null>(null);


  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string, ms = 2400) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), ms);
  }, []);

  useEffect(() => {
    if (!getSavedDisplayName() && defaultName) setName(defaultName);
  }, [defaultName]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // --- Stop helper ---
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

  // --- Refresh device list ---
  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const cams: DeviceInfo[] = [];
      const ms: DeviceInfo[] = [];
      const spk: DeviceInfo[] = [];
      list.forEach((d, idx) => {
        const label = d.label || `${d.kind === "videoinput" ? "Camera" : d.kind === "audioinput" ? "Microphone" : "Speaker"} ${idx + 1}`;
        const info: DeviceInfo = { deviceId: d.deviceId, label, kind: d.kind };
        if (d.kind === "videoinput") cams.push(info);
        else if (d.kind === "audioinput") ms.push(info);
        else if (d.kind === "audiooutput") spk.push(info);
      });
      setCameras(cams);
      setMics(ms);
      setSpeakers(spk);

      // Resolve saved IDs against current list; fall back to default and toast if missing.
      const resolve = (saved: string, all: DeviceInfo[], label: string) => {
        if (!saved) return "";
        if (all.some((d) => d.deviceId === saved)) return saved;
        if (all.length > 0) showToast(`Previous ${label} no longer available — using default`);
        return "";
      };
      setVideoDeviceId((cur) => resolve(cur, cams, "camera"));
      setAudioDeviceId((cur) => resolve(cur, ms, "microphone"));
      setAudioOutputDeviceId((cur) => resolve(cur, spk, "speaker"));
    } catch {
      // ignore
    }
  }, [showToast]);

  // Listen for plug/unplug
  useEffect(() => {
    const onChange = () => { refreshDevices(); };
    try { navigator.mediaDevices.addEventListener("devicechange", onChange); } catch {}
    return () => {
      try { navigator.mediaDevices.removeEventListener("devicechange", onChange); } catch {}
    };
  }, [refreshDevices]);

  // --- Acquire camera + mic stream when toggles or selected devices change ---
  useEffect(() => {
    let cancelled = false;
    async function acquire() {
      stopStream();
      if (!video && !audio) {
        await refreshDevices();
        return;
      }
      setAcquiring(true);
      try {
        const videoConstraints: MediaTrackConstraints | false = video
          ? {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              facingMode: "user",
              ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}),
            }
          : false;
        const audioConstraints: MediaTrackConstraints | false = audio
          ? {
              echoCancellation: ec,
              noiseSuppression: ns,
              autoGainControl: agc,
              ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
            }
          : false;
        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: audioConstraints,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        setPermError(null);
        // After permission is granted, labels become available.
        await refreshDevices();
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
        await refreshDevices();
      } finally {
        if (!cancelled) setAcquiring(false);
      }
    }
    acquire();
    return () => { cancelled = true; stopStream(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, audio, videoDeviceId, audioDeviceId, ns, ec, agc]);

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


  // --- Mic test: record 3s, play back through chosen speaker ---
  const stopMicTest = useCallback(() => {
    try { micRecorderRef.current?.stop(); } catch {}
    micRecorderRef.current = null;
    if (micTestTimerRef.current) { clearInterval(micTestTimerRef.current); micTestTimerRef.current = null; }
    if (micTestAudioRef.current) {
      try { micTestAudioRef.current.pause(); } catch {}
      micTestAudioRef.current = null;
    }
    setMicTesting("idle");
    setMicTestProgress(0);
  }, []);

  const startMicTest = useCallback(async () => {
    if (micTesting !== "idle") { stopMicTest(); return; }
    const stream = streamRef.current;
    if (!stream || !audio) { showToast("Turn on the microphone to test it"); return; }
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) { showToast("No microphone track available"); return; }
    try {
      const audioOnlyStream = new MediaStream(audioTracks);
      if (!(window as any).MediaRecorder) { showToast("Mic test not supported in this browser"); return; }
      const mime = (MediaRecorder as any).isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(audioOnlyStream, mime ? { mimeType: mime } : undefined);
      micTestChunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) micTestChunksRef.current.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(micTestChunksRef.current, { type: mime || "audio/webm" });
        const url = URL.createObjectURL(blob);
        const a = new Audio(url);
        micTestAudioRef.current = a;
        if (canSetSink && audioOutputDeviceId) {
          try { await (a as any).setSinkId(audioOutputDeviceId); } catch {}
        }
        a.onended = () => { URL.revokeObjectURL(url); stopMicTest(); };
        setMicTesting("playing");
        setMicTestProgress(0);
        const playStart = performance.now();
        micTestTimerRef.current = window.setInterval(() => {
          const dur = (a.duration && isFinite(a.duration)) ? a.duration * 1000 : 3000;
          const pct = Math.min(1, (performance.now() - playStart) / dur);
          setMicTestProgress(pct);
        }, 50);
        try { await a.play(); } catch { stopMicTest(); }
      };
      micRecorderRef.current = rec;
      rec.start();
      setMicTesting("recording");
      setMicTestProgress(0);
      const recStart = performance.now();
      micTestTimerRef.current = window.setInterval(() => {
        const pct = Math.min(1, (performance.now() - recStart) / 3000);
        setMicTestProgress(pct);
        if (pct >= 1) {
          if (micTestTimerRef.current) { clearInterval(micTestTimerRef.current); micTestTimerRef.current = null; }
          try { rec.stop(); } catch {}
        }
      }, 50);
    } catch {
      showToast("Mic test failed");
      stopMicTest();
    }
  }, [audio, audioOutputDeviceId, canSetSink, micTesting, showToast, stopMicTest]);

  useEffect(() => () => { stopMicTest(); }, [stopMicTest]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (joining || acquiring) return;
    const trimmed = name.trim() || defaultName || "Guest";
    saveDisplayName(trimmed);
    writeDeviceId(VIDEO_DEV_KEY, videoDeviceId);
    writeDeviceId(AUDIO_DEV_KEY, audioDeviceId);
    writeDeviceId(AUDIO_OUT_KEY, audioOutputDeviceId);
    setJoining(true);
    setTimeout(() => {
      onSubmit({
        username: trimmed,
        videoEnabled: video,
        audioEnabled: audio,
        videoDeviceId: videoDeviceId || undefined,
        audioDeviceId: audioDeviceId || undefined,
        audioOutputDeviceId: audioOutputDeviceId || undefined,
      });
    }, 280);
  };

  const retryPermissions = useCallback(() => {
    setPermError(null);
    setVideo((v) => v);
    setAudio((a) => a);
  }, []);

  const qualityMeta: Record<Quality, { label: string; color: string; bars: number }> = {
    checking: { label: "Checking...", color: "text-zinc-400", bars: 0 },
    excellent: { label: "Excellent", color: "text-emerald-300", bars: 4 },
    good: { label: "Good", color: "text-cyan-300", bars: 3 },
    poor: { label: "Poor", color: "text-amber-300", bars: 2 },
    offline: { label: "Offline", color: "text-rose-400", bars: 1 },
  };
  const qm = qualityMeta[quality];

  const joinDisabled = joining || acquiring;

  return (
    <div className="fixed inset-0 z-30 overflow-hidden bg-[#040713] text-white">
      <div aria-hidden className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-40 -left-40 w-[40rem] h-[40rem] rounded-full bg-cyan-500/20 blur-3xl animate-pulse" />
        <div className="absolute -bottom-40 -right-40 w-[40rem] h-[40rem] rounded-full bg-fuchsia-500/10 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(34,211,238,0.08),transparent_60%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent,rgba(0,0,0,0.4))]" />
      </div>

      <div className="relative h-full w-full overflow-y-auto px-4 py-8 md:py-12">
        <div className="mx-auto max-w-6xl grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-6 lg:gap-10 items-start min-h-[calc(100vh-4rem)]">

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
                {permError && (
                  <button
                    type="button"
                    onClick={retryPermissions}
                    className="mt-3 px-3 py-1.5 text-xs rounded-full border border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/10 transition"
                  >Retry permissions</button>
                )}
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
                <div className="text-[10px] uppercase tracking-[0.35em] text-cyan-400/80">You’re joining</div>
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

            {/* Device pickers */}
            <div className="space-y-3 mb-5">
              <DevicePicker
                label="Camera"
                kind="video"
                disabled={!video}
                devices={cameras}
                value={videoDeviceId}
                onChange={setVideoDeviceId}
              />
              <div>
                <DevicePicker
                  label="Microphone"
                  kind="mic"
                  disabled={!audio}
                  devices={mics}
                  value={audioDeviceId}
                  onChange={setAudioDeviceId}
                  rightSlot={(
                    <button
                      type="button"
                      onClick={startMicTest}
                      disabled={!audio || micTesting === "playing"}
                      title={micTesting === "idle" ? "Record a 3-second mic sample" : micTesting === "recording" ? "Recording… click to cancel" : "Playing back…"}
                      className={`shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition border ${audio ? "border-cyan-400/40 text-cyan-200 hover:bg-cyan-400/10" : "border-white/10 text-zinc-600 cursor-not-allowed"} ${micTesting !== "idle" ? "bg-cyan-400/20" : ""}`}
                    >
                      {micTesting === "idle" && "Test mic"}
                      {micTesting === "recording" && "Recording…"}
                      {micTesting === "playing" && "Playing…"}
                    </button>
                  )}
                />
                {micTesting !== "idle" && (
                  <div className="mt-1.5 h-1 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className={`h-full transition-[width] duration-75 ${micTesting === "recording" ? "bg-rose-400" : "bg-cyan-400"}`}
                      style={{ width: `${Math.round(micTestProgress * 100)}%` }}
                    />
                  </div>
                )}
              </div>
              {canSetSink && speakers.length > 0 && (
                <DevicePicker
                  label="Speaker"
                  kind="speaker"
                  disabled={false}
                  devices={speakers}
                  value={audioOutputDeviceId}
                  onChange={setAudioOutputDeviceId}
                  rightSlot={(
                    <SpeakerTestButton deviceId={audioOutputDeviceId} canSetSink={canSetSink} compact />
                  )}
                />
              )}
              {!canSetSink && (
                <p className="text-[10px] text-zinc-500 italic">Speaker selection isn’t available in this browser. The system default will be used.</p>
              )}
            </div>

            {/* Mic level meter */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] uppercase tracking-[0.25em] text-cyan-400/70">Mic input</span>
                <span className="text-[11px] text-zinc-500">{audio ? (micLevel > 0.04 ? "Speaking" : "Silent") : "Off"}</span>
              </div>
              {audio ? (
                <MicLevelMeter deviceId={audioDeviceId} autoStart hideControls />
              ) : (
                <div className="h-2 rounded-full bg-white/5 overflow-hidden border border-white/5" aria-hidden="true" />
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 mb-7">
              <ToggleTile label="Camera" on={video} onChange={setVideo} kind="video" />
              <ToggleTile label="Microphone" on={audio} onChange={setAudio} kind="mic" />
            </div>
            <div className="mb-7">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] uppercase tracking-[0.25em] text-cyan-400/70">Audio processing</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <AudioPrefPill
                  label="Noise"
                  hint="Suppress keyboards, fans"
                  on={ns}
                  disabled={!audio}
                  onToggle={() => {
                    const next = !ns;
                    setNs(next);
                    try { localStorage.setItem("neoconf:audio:noiseSuppression", next ? "1" : "0"); } catch {}
                  }}
                />
                <AudioPrefPill
                  label="Echo cancel"
                  hint="No speaker echo"
                  on={ec}
                  disabled={!audio}
                  onToggle={() => {
                    const next = !ec;
                    setEc(next);
                    try { localStorage.setItem("neoconf:audio:echoCancellation", next ? "1" : "0"); } catch {}
                  }}
                />
                <AudioPrefPill
                  label="Auto gain"
                  hint="Level your voice"
                  on={agc}
                  disabled={!audio}
                  onToggle={() => {
                    const next = !agc;
                    setAgc(next);
                    try { localStorage.setItem("neoconf:audio:autoGainControl", next ? "1" : "0"); } catch {}
                  }}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={joinDisabled}
              className={`group w-full py-3.5 rounded-xl font-bold text-lg tracking-wide transition active:scale-[0.99] ${joinDisabled ? "bg-cyan-400/40 text-black/70 cursor-not-allowed" : "bg-gradient-to-r from-cyan-400 to-cyan-500 hover:from-cyan-300 hover:to-cyan-400 text-black shadow-[0_0_30px_rgba(34,211,238,0.45)]"}`}
            >
              {joining ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <span className="w-4 h-4 rounded-full border-2 border-black/40 border-t-black animate-spin" />
                  Joining...
                </span>
              ) : acquiring ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <span className="w-4 h-4 rounded-full border-2 border-black/40 border-t-black animate-spin" />
                  Preparing devices…
                </span>
              ) : (
                <span className="inline-flex items-center justify-center gap-2">Join Room <span className="transition group-hover:translate-x-1">→</span></span>
              )}
            </button>

            <p className="text-center text-[11px] text-zinc-500 mt-4">
              {permError ? "Permissions blocked. You can still join with mic & camera off." : "Your name and device choices are saved for future sessions."}
            </p>
          </form>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-zinc-900/95 backdrop-blur border border-cyan-400/30 text-cyan-100 text-sm shadow-xl pointer-events-none">
          {toast}
        </div>
      )}
    </div>
  );
}

function DevicePicker({
  label,
  kind,
  devices,
  value,
  onChange,
  disabled,
  rightSlot,
}: {
  label: string;
  kind: "video" | "mic" | "speaker";
  devices: DeviceInfo[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  rightSlot?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); buttonRef.current?.focus(); } };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = devices.find((d) => d.deviceId === value);
  const displayLabel = selected?.label || (devices.length > 0 ? "Default (system)" : "No devices found");

  const Icon = () => (
    <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0 text-cyan-300" fill="none" stroke="currentColor" strokeWidth="1.7">
      {kind === "video" && (<path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />)}
      {kind === "mic" && (<path strokeLinecap="round" strokeLinejoin="round" d="M12 18v3m-4 0h8M5 11a7 7 0 0014 0M12 14a3 3 0 01-3-3V6a3 3 0 016 0v5a3 3 0 01-3 3z" />)}
      {kind === "speaker" && (<path strokeLinecap="round" strokeLinejoin="round" d="M11 5L6 9H3v6h3l5 4V5zM15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" />)}
    </svg>
  );

  return (
    <div ref={rootRef} className="relative">
      <div className={`text-[10px] uppercase tracking-[0.22em] mb-1 ${disabled ? "text-zinc-600" : "text-cyan-400/70"}`}>{label}</div>
      <div className="flex items-stretch gap-2">
        <button
          ref={buttonRef}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Select ${label}`}
          onClick={() => !disabled && setOpen((o) => !o)}
          className={`flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded-xl border text-left text-sm transition ${disabled ? "bg-black/30 border-white/5 text-zinc-600 cursor-not-allowed" : "bg-black/60 border-white/10 hover:border-cyan-400/40 text-zinc-100"}`}
        >
          <Icon />
          <span className="truncate flex-1">{displayLabel}</span>
          <svg viewBox="0 0 24 24" className={`w-4 h-4 shrink-0 transition ${open ? "rotate-180" : ""} ${disabled ? "text-zinc-600" : "text-zinc-400"}`} fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6"/></svg>
        </button>
        {rightSlot}
      </div>
      {open && !disabled && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label={label}
          className="absolute z-50 mt-1 left-0 right-0 max-h-60 overflow-auto rounded-xl border border-cyan-400/30 bg-zinc-950/95 backdrop-blur-xl shadow-2xl py-1"
        >
          {devices.length === 0 && (
            <li className="px-3 py-2 text-xs text-zinc-500">No devices detected. Grant permissions to see options.</li>
          )}
          {devices.length > 0 && (
            <li>
              <button
                type="button"
                role="option"
                aria-selected={!value}
                onClick={() => { onChange(""); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${!value ? "bg-cyan-400/10 text-cyan-200" : "text-zinc-200 hover:bg-white/5"}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${!value ? "bg-cyan-300" : "bg-transparent"}`} />
                <span className="flex-1 truncate">Default (system)</span>
              </button>
            </li>
          )}
          {devices.map((d) => (
            <li key={d.deviceId}>
              <button
                type="button"
                role="option"
                aria-selected={value === d.deviceId}
                onClick={() => { onChange(d.deviceId); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${value === d.deviceId ? "bg-cyan-400/10 text-cyan-200" : "text-zinc-200 hover:bg-white/5"}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${value === d.deviceId ? "bg-cyan-300" : "bg-transparent"}`} />
                <span className="flex-1 truncate">{d.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
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

/**
 * AudioPrefPill
 *
 * Compact toggle pill for the prejoin Audio Processing row. Three of these
 * map to the same neoconf:audio:* localStorage keys read by the in-call
 * DeviceSwitcher so the prejoin and in-room UIs stay in sync.
 */
function AudioPrefPill({ label, hint, on, onToggle, disabled }: { label: string; hint: string; on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${label}: ${on ? "on" : "off"}. ${hint}`}
      title={hint}
      onClick={onToggle}
      disabled={disabled}
      className={`group flex flex-col items-start gap-1 px-3 py-2 rounded-xl border text-left transition ${
        disabled
          ? "border-white/5 bg-black/30 text-zinc-600 cursor-not-allowed"
          : on
            ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100 shadow-[0_0_18px_rgba(34,211,238,0.15)]"
            : "border-white/10 bg-black/40 text-zinc-400 hover:text-zinc-200"
      }`}
    >
      <span className="flex items-center justify-between w-full">
        <span className="text-[12px] font-semibold tracking-wide">{label}</span>
        <span
          aria-hidden="true"
          className={`inline-block w-7 h-4 rounded-full relative transition ${
            disabled ? "bg-white/5" : on ? "bg-cyan-400" : "bg-white/15"
          }`}
        >
          <span
            className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-[left] ${
              on ? "left-[14px]" : "left-0.5"
            }`}
          />
        </span>
      </span>
      <span className="text-[10px] leading-tight text-zinc-500">{hint}</span>
    </button>
  );
}