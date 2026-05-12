"use client";

// src/components/MicRecordTest.tsx
//
// Self-contained "Record-and-playback" mic test widget.
//
// Records ~3 seconds from the selected audio input, then plays it back
// through the selected audio output via setSinkId (if supported). This is
// the canonical Zoom / Google Meet / Whereby "test microphone" pattern that
// gives users a definitive answer to: "Will the other side actually hear me?"
//
// Used both in the prejoin screen (RoomNameEntry) and in Settings -> Audio.
//
// Design constraints:
//   - Privacy-first: never opens the mic until the user clicks "Test mic".
//   - Independent stream: requests its own getUserMedia so this widget works
//     regardless of whether a LiveKit publish track exists.
//   - Always cleans up: stream/recorder/audio element/timers all released on
//     stop, unmount, or device change.
//   - Honest playback: plays the actual recorded webm/opus blob through the
//     user's chosen speaker so latency/processing artifacts surface.

import { useCallback, useEffect, useRef, useState } from "react";

type State = "idle" | "recording" | "playing";

export type MicRecordTestProps = {
  /** Microphone deviceId to record from. If omitted, browser default is used. */
  deviceId?: string;
  /** Speaker deviceId to play back through. Requires setSinkId support. */
  audioOutputDeviceId?: string;
  /** Whether the browser supports HTMLMediaElement.setSinkId. */
  canSetSink?: boolean;
  /** Hide the descriptive helper text under the button (used in dense layouts like prejoin). */
  compact?: boolean;
  /** Disable the button (e.g. if no mic device is available). */
  disabled?: boolean;
  /** Optional toast hook for non-blocking error surfaces. */
  onError?: (message: string) => void;
};

const RECORD_MS = 3000;

export default function MicRecordTest({
  deviceId,
  audioOutputDeviceId,
  canSetSink = false,
  compact = false,
  disabled = false,
  onError,
}: MicRecordTestProps) {
  const [state, setState] = useState<State>("idle");
  const [progress, setProgress] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const urlRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try { recorderRef.current?.stop(); } catch {}
    recorderRef.current = null;
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch {}
      audioRef.current = null;
    }
    if (streamRef.current) {
      try { streamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
      streamRef.current = null;
    }
    if (urlRef.current) {
      try { URL.revokeObjectURL(urlRef.current); } catch {}
      urlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    cleanup();
    setState("idle");
    setProgress(0);
  }, [cleanup]);

  const start = useCallback(async () => {
    if (state !== "idle") { stop(); return; }
    if (typeof window === "undefined" || !(window as unknown as { MediaRecorder?: unknown }).MediaRecorder) {
      onError?.("Mic test isn't supported in this browser");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId
          ? { deviceId: { exact: deviceId }, noiseSuppression: true, echoCancellation: true, autoGainControl: true }
          : { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
        video: false,
      });
    } catch {
      onError?.("Couldn't access the microphone");
      return;
    }
    streamRef.current = stream;
    try {
      const mime = (MediaRecorder as unknown as { isTypeSupported: (s: string) => boolean }).isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        // Release the recording stream as soon as recording finishes; playback uses the blob.
        try { stream.getTracks().forEach((t) => t.stop()); } catch {}
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const a = new Audio(url);
        audioRef.current = a;
        if (canSetSink && audioOutputDeviceId) {
          try { await (a as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(audioOutputDeviceId); } catch {}
        }
        a.onended = () => { stop(); };
        setState("playing");
        setProgress(0);
        const playStart = performance.now();
        timerRef.current = window.setInterval(() => {
          const dur = a.duration && isFinite(a.duration) ? a.duration * 1000 : RECORD_MS;
          const pct = Math.min(1, (performance.now() - playStart) / dur);
          setProgress(pct);
        }, 50);
        try { await a.play(); } catch { stop(); }
      };
      recorderRef.current = rec;
      rec.start();
      setState("recording");
      setProgress(0);
      const recStart = performance.now();
      timerRef.current = window.setInterval(() => {
        const pct = Math.min(1, (performance.now() - recStart) / RECORD_MS);
        setProgress(pct);
        if (pct >= 1) {
          if (timerRef.current != null) { clearInterval(timerRef.current); timerRef.current = null; }
          try { rec.stop(); } catch {}
        }
      }, 50);
    } catch {
      onError?.("Mic test failed");
      stop();
    }
  }, [state, deviceId, audioOutputDeviceId, canSetSink, onError, stop]);

  // Cleanup on unmount.
  useEffect(() => () => { cleanup(); }, [cleanup]);

  // If the selected mic device changes mid-test, abort and reset.
  useEffect(() => {
    if (state !== "idle") stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const label =
    state === "recording" ? "Recording…" : state === "playing" ? "Playing…" : "Test mic";
  const title =
    state === "idle"
      ? "Record a 3-second mic sample and play it back through your chosen speaker"
      : state === "recording"
        ? "Recording… click to cancel"
        : "Playing back… click to cancel";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={start}
          disabled={disabled || state === "playing"}
          title={title}
          aria-label={title}
          className={`shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition border ${disabled ? "border-white/10 text-zinc-600 cursor-not-allowed" : "border-cyan-400/40 text-cyan-200 hover:bg-cyan-400/10"} ${state !== "idle" ? "bg-cyan-400/20" : ""}`}
        >
          {label}
        </button>
        {!compact && (
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.55)" }}>
            Records 3 seconds and plays it back through your speaker.
          </span>
        )}
      </div>
      {state !== "idle" && (
        <div className="h-1 rounded-full bg-white/5 overflow-hidden">
          <div
            className={`h-full transition-[width] duration-75 ${state === "recording" ? "bg-rose-400" : "bg-cyan-400"}`}
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
