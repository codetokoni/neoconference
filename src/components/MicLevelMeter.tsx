"use client";

// src/components/MicLevelMeter.tsx
//
// Self-contained "Test microphone" widget for Settings -> Audio.
//
// Renders a horizontal level meter (RMS, 20 segments, green -> yellow -> red)
// fed by a getUserMedia stream on the selected audioinput device. Mirrors the
// canonical Zoom / Google Meet "test mic" pattern: opaque raw input level so
// users can verify their mic is actually picking up sound before joining or
// while troubleshooting mid-call.
//
// Design constraints:
//   - Privacy-first: never opens the mic until the user clicks "Start test".
//     The browser indicator dot only lights up on explicit user gesture.
//   - Independent stream: requests a separate getUserMedia with NS/EC/AGC
//     disabled so the meter shows the raw signal, not the post-processed
//     LiveKit track. This means you can verify "the mic is working" even
//     when noise suppression is aggressively zeroing quiet input.
//   - Zero LiveKit interference: never touches room.localParticipant or any
//     published track. Cannot accidentally mute / republish the real mic.
//   - Hot device switching: listens for `neoconf:device-select` of kind
//     "audioinput" so if the user picks a different mic from the Settings
//     dropdown while the test is running, we tear down and re-acquire.
//   - Clean teardown: stops every track, closes the AudioContext, and
//     cancels the rAF on unmount or when the user clicks "Stop test".

import { useEffect, useRef, useState, useCallback } from "react";

type Props = {
  /** Selected audioinput deviceId. Empty string or undefined => browser default. */
  deviceId?: string;
};

const SEGMENTS = 20;

/** Convert an RMS amplitude (0..~0.5) to a 0..1 displayable level with mild log feel. */
function shapeLevel(rms: number): number {
  // RMS for typical speech sits around 0.05-0.2, peaks ~0.4. Lift small values
  // so the meter feels responsive without being jumpy at silence.
  const x = Math.max(0, Math.min(1, rms * 3.2));
  return Math.pow(x, 0.65);
}

export default function MicLevelMeter({ deviceId }: Props) {
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0); // 0..1, smoothed for display
  const [error, setError] = useState<string | null>(null);

  // Refs survive across renders and across deviceId changes without retriggering effects.
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const bufRef = useRef<Float32Array | null>(null);
  const smoothedRef = useRef(0);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try { sourceRef.current?.disconnect(); } catch {}
    sourceRef.current = null;
    analyserRef.current = null;
    if (streamRef.current) {
      try { streamRef.current.getTracks().forEach(t => t.stop()); } catch {}
      streamRef.current = null;
    }
    if (ctxRef.current) {
      try { ctxRef.current.close(); } catch {}
      ctxRef.current = null;
    }
    bufRef.current = null;
    smoothedRef.current = 0;
    setLevel(0);
  }, []);

  const start = useCallback(async (devId?: string) => {
    setError(null);
    teardown();
    try {
      // Open a *separate* stream from the LiveKit publish path so the meter
      // shows the raw mic level (no NS / EC / AGC applied).
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: devId ? { exact: devId } : undefined,
          noiseSuppression: false,
          echoCancellation: false,
          autoGainControl: false,
        },
        video: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      const AC: typeof AudioContext =
        (window.AudioContext as any) || (window as any).webkitAudioContext;
      const ctx = new AC();
      ctxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      analyserRef.current = analyser;
      bufRef.current = new Float32Array(analyser.fftSize);

      const tick = () => {
        const a = analyserRef.current;
        const buf = bufRef.current;
        if (!a || !buf) return;
        a.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        const target = shapeLevel(rms);
        // Asymmetric smoothing: fast attack, slow release (feels musical).
        const prev = smoothedRef.current;
        const next = target > prev ? prev + (target - prev) * 0.55 : prev + (target - prev) * 0.18;
        smoothedRef.current = next;
        setLevel(next);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      setActive(true);
    } catch (e: any) {
      const name = e?.name || "Error";
      let msg = "Could not open the microphone for testing.";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        msg = "Microphone permission is blocked. Allow it in your browser settings to run the test.";
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        msg = "Selected microphone is not available. Pick another one and try again.";
      } else if (name === "NotReadableError") {
        msg = "Another app is using this microphone. Close it and try again.";
      }
      setError(msg);
      teardown();
      setActive(false);
    }
  }, [teardown]);

  const stop = useCallback(() => {
    teardown();
    setActive(false);
  }, [teardown]);

  // If user picks a different mic while the test is running, hot-swap streams.
  useEffect(() => {
    if (!active) return;
    void start(deviceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // Also react to global device-select events (e.g. fired by SettingsModal applyMic).
  useEffect(() => {
    function onSelect(ev: Event) {
      if (!active) return;
      const detail = (ev as CustomEvent).detail as { kind?: string; deviceId?: string } | undefined;
      if (!detail || detail.kind !== "audioinput") return;
      void start(detail.deviceId);
    }
    window.addEventListener("neoconf:device-select", onSelect as EventListener);
    return () => window.removeEventListener("neoconf:device-select", onSelect as EventListener);
  }, [active, start]);

  // Clean up on unmount (covers SettingsModal close, route change, etc.).
  useEffect(() => {
    return () => { teardown(); };
  }, [teardown]);

  const segments = Array.from({ length: SEGMENTS }, (_, i) => {
    const segThreshold = (i + 1) / SEGMENTS;
    const lit = level >= segThreshold - 0.5 / SEGMENTS;
    // Green for the bottom 65%, yellow for the next 20%, red for the top 15%.
    let color = "#2bd17e"; // green
    if (segThreshold > 0.85) color = "#ff5b5b";
    else if (segThreshold > 0.65) color = "#f5c451";
    return (
      <span
        key={i}
        aria-hidden="true"
        style={{
          flex: 1,
          height: 10,
          borderRadius: 2,
          background: lit ? color : "rgba(255,255,255,0.08)",
          transition: lit ? "background 60ms linear" : "background 180ms ease-out",
        }}
      />
    );
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        role="meter"
        aria-label="Microphone input level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
        style={{ display: "flex", gap: 3, alignItems: "stretch" }}
      >
        {segments}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => (active ? stop() : start(deviceId))}
          aria-pressed={active}
          style={{
            padding: "6px 12px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.14)",
            background: active ? "rgba(255,91,91,0.18)" : "rgba(43,209,126,0.18)",
            color: active ? "#ffb4b4" : "#aef2cf",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {active ? "Stop test" : "Start test"}
        </button>
        <span style={{ fontSize: 11, color: "#9aa2b4" }}>
          {active
            ? "Speak normally — you should see the bars react."
            : "Click Start test to verify your microphone is picking up sound."}
        </span>
      </div>
      {error && (
        <div role="alert" style={{ fontSize: 11, color: "#ff9d9d" }}>
          {error}
        </div>
      )}
    </div>
  );
}
