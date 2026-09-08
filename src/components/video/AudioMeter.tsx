"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live audio level meter for the Studio.
 *
 * An operator needs to see that their mic is actually being captured
 * before they trust the "You are live" chip. Feed us the same
 * MediaStream the publisher is sending, and this component paints a
 * green-→-yellow-→-red bar driven by the analyser's frequency data.
 *
 * Deliberately visual, not audible — an audible monitor would feedback
 * through the operator's own speakers. If they want to hear themselves,
 * that's a headphone job outside the browser.
 */
export default function AudioMeter({ stream }: { stream: MediaStream | null }) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!stream) {
      setLevel(0);
      return;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      setLevel(0);
      return;
    }

    let ctx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;

    try {
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (cancelled) return;
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length / 255;
        // Scale for speech: an unmuted mic at normal talking distance
        // sits around 0.05..0.25 raw, so 200% gain keeps the bar in
        // the visible range without saturating at everything.
        setLevel(Math.min(1, avg * 2));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch {
      /* AudioContext denied / unsupported — leave the bar at 0 */
    }

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      if (ctx) ctx.close().catch(() => {});
    };
  }, [stream]);

  const pct = Math.round(level * 100);
  const colour = pct > 80 ? "#f43f5e" : pct > 45 ? "#eab308" : "#10b981";

  return (
    <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/50">
      <span>Mic</span>
      <div
        className="h-1.5 w-32 overflow-hidden rounded-full border border-white/15 bg-black/60"
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className="h-full transition-[width] duration-100 ease-out"
          style={{ width: `${pct}%`, background: colour }}
        />
      </div>
    </div>
  );
}
