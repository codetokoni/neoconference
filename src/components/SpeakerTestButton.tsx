"use client";

// src/components/SpeakerTestButton.tsx
//
// "Test speaker" widget for Settings -> Audio. Plays a short, pleasant 440Hz
// reference tone (sine + 5ms fade in/out) routed via setSinkId to whatever
// audiooutput device the user has selected. Mirrors Zoom / Google Meet:
// pairs naturally with the speaker picker so users can confirm sound is
// actually coming out of the device they expect.
//
// Design constraints:
//   - No mic permission ever required (this is the *output* test).
//   - Tone duration is short (~700ms) and shaped with a tiny linear ramp so
//     it never produces a harsh click on start / stop.
//   - Volume is conservative (0.18 gain) so it does not blast users who
//     have their system volume cranked up; loud enough to verify routing.
//   - Auto-cancels if the user clicks again while a tone is playing.
//   - Auto-stops at the end of the tone (no zombie audio elements).
//   - Routing strategy: WebAudio Oscillator -> Gain -> MediaStreamDestination
//     -> hidden <audio>.srcObject -> setSinkId(deviceId). This is the only
//     reliable way to direct WebAudio output to a non-default sink across
//     Chrome / Edge today; Firefox falls back to default output silently.
//   - Graceful degradation: if setSinkId throws, we still play the tone on
//     the default device and show a tiny note so the test is never silent.

import { useEffect, useRef, useState, useCallback } from "react";

type Props = {
  /** Selected audiooutput deviceId. Empty / undefined => system default. */
  deviceId?: string;
  /** Whether the browser advertises HTMLMediaElement.setSinkId. */
  canSetSink: boolean;
  /** Compact mode: hide the secondary helper text so the button can sit inline (e.g. inside DevicePicker rightSlot). */
  compact?: boolean;
};

const TONE_HZ = 440;
const TONE_DURATION_MS = 700;
const TONE_GAIN = 0.18;
const FADE_MS = 12;

export default function SpeakerTestButton({ deviceId, canSetSink, compact = false }: Props) {
  const [playing, setPlaying] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Refs survive across renders, get cleaned up on unmount.
  const ctxRef = useRef<AudioContext | null>(null);
  const oscRef = useRef<OscillatorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const teardown = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    try { oscRef.current?.stop(); } catch {}
    try { oscRef.current?.disconnect(); } catch {}
    try { gainRef.current?.disconnect(); } catch {}
    try { destRef.current?.disconnect(); } catch {}
    oscRef.current = null;
    gainRef.current = null;
    destRef.current = null;
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch {}
      audioRef.current.srcObject = null;
      audioRef.current = null;
    }
    if (ctxRef.current) {
      try { ctxRef.current.close(); } catch {}
      ctxRef.current = null;
    }
  }, []);

  const play = useCallback(async () => {
    setNote(null);
    teardown();
    try {
      const AC: typeof AudioContext =
        (window.AudioContext as any) || (window as any).webkitAudioContext;
      const ctx = new AC();
      ctxRef.current = ctx;

      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = TONE_HZ;
      oscRef.current = osc;

      const gain = ctx.createGain();
      gain.gain.value = 0;
      gainRef.current = gain;

      // Linear fade in / fade out to avoid clicks.
      const now = ctx.currentTime;
      const fade = FADE_MS / 1000;
      const dur = TONE_DURATION_MS / 1000;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(TONE_GAIN, now + fade);
      gain.gain.setValueAtTime(TONE_GAIN, now + dur - fade);
      gain.gain.linearRampToValueAtTime(0, now + dur);

      osc.connect(gain);

      // Route via MediaStreamDestination + <audio>.setSinkId so the tone
      // actually plays out of the user-selected speaker (not the system
      // default WebAudio output). Falls back to default if setSinkId fails.
      const dest = ctx.createMediaStreamDestination();
      destRef.current = dest;
      gain.connect(dest);

      const audio = new Audio();
      audio.autoplay = false;
      audio.srcObject = dest.stream;
      audioRef.current = audio;

      let routed = false;
      if (canSetSink && deviceId) {
        try {
          // setSinkId is typed loosely across browsers; cast just for this call.
          await (audio as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId);
          routed = true;
        } catch {
          setNote("Could not route to the selected speaker; playing through the system default instead.");
        }
      }
      if (!routed && canSetSink && !deviceId) {
        // explicit "default" choice -- no setSinkId needed
      } else if (!canSetSink && deviceId) {
        setNote("This browser cannot route audio to specific speakers; playing through the system default.");
      }

      await audio.play();
      osc.start();
      osc.stop(now + dur);
      setPlaying(true);

      timeoutRef.current = window.setTimeout(() => {
        teardown();
        setPlaying(false);
      }, TONE_DURATION_MS + 40);
    } catch (e: any) {
      teardown();
      setPlaying(false);
      setNote("Could not play the test tone. Try selecting a different speaker.");
    }
  }, [deviceId, canSetSink, teardown]);

  const stop = useCallback(() => {
    teardown();
    setPlaying(false);
  }, [teardown]);

  // Cleanup on unmount (covers SettingsModal close, route change, etc.).
  useEffect(() => {
    return () => { teardown(); };
  }, [teardown]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => (playing ? stop() : play())}
          aria-pressed={playing}
          aria-label={playing ? "Stop speaker test tone" : "Play speaker test tone"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.14)",
            background: playing ? "rgba(255,91,91,0.18)" : "rgba(120,170,255,0.18)",
            color: playing ? "#ffb4b4" : "#bcd5ff",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: playing ? "#ff5b5b" : "#7aa8ff",
              boxShadow: playing ? "0 0 10px rgba(255,91,91,0.7)" : "none",
              transition: "box-shadow 200ms ease-out",
            }}
          />
          {playing ? "Playing…" : "Test speaker"}
        </button>
        {!compact && (
        <span style={{ fontSize: 11, color: "#9aa2b4" }}>
          {playing
            ? "You should hear a short tone from the selected speaker."
            : "Plays a short 440 Hz tone so you can confirm sound is coming out of the right device."}
        </span>
        )}
      </div>
      {note && (
        <div role="status" style={{ fontSize: 11, color: "#f5c451" }}>
          {note}
        </div>
      )}
    </div>
  );
}
