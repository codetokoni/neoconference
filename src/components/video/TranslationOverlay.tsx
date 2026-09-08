"use client";

import { useEffect, useRef, useState } from "react";

interface Line {
  lang: string;
  text: string;
  seq: number;
  ts: number;
  original?: string;
  final?: boolean;
}

/**
 * Client-side translation display.
 *
 * When the viewer picks a non-source language on the SimulcastPlayer's
 * rail, this component connects to the translation worker's SSE feed
 * for that (room, lang), shows the latest caption over the video, and
 * speaks each FINAL utterance through the browser's SpeechSynthesis
 * API. Interim results update the on-screen text but don't speak,
 * because the browser TTS engine can't gracefully cancel mid-sentence
 * without stuttering.
 *
 * Configured via the NEXT_PUBLIC_TRANSLATION_SSE env var. Component
 * renders nothing when the env var is missing — the language rail then
 * behaves as before (silent switch for languages nobody is publishing
 * to as an interpreter booth).
 */
export default function TranslationOverlay({
  room,
  lang,
  active,
  muted,
}: {
  room: string;
  lang: string;
  active: boolean;
  muted: boolean;
}) {
  const [line, setLine] = useState<Line | null>(null);
  const spokenSeqRef = useRef<number>(0);

  useEffect(() => {
    if (!active) {
      setLine(null);
      // Cancel anything still queued so switching languages stops the
      // previous language mid-word instead of talking over the new one.
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
      return;
    }
    const base = process.env.NEXT_PUBLIC_TRANSLATION_SSE?.trim().replace(/\/$/, "");
    if (!base) return;

    const url = `${base}/translations/${encodeURIComponent(room)}/${encodeURIComponent(lang)}`;
    const es = new EventSource(url);

    es.onmessage = (ev) => {
      try {
        const l = JSON.parse(ev.data) as Line;
        setLine(l);
      } catch {
        /* malformed line; skip */
      }
    };
    es.onerror = () => {
      // EventSource reconnects on its own; nothing to do here.
    };

    return () => {
      es.close();
    };
  }, [active, room, lang]);

  // Speak final utterances. Interim ones update the visible caption
  // but don't queue speech, so a long utterance doesn't stutter.
  useEffect(() => {
    if (!active || muted || !line || !line.final) return;
    if (line.seq <= spokenSeqRef.current) return;
    spokenSeqRef.current = line.seq;

    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth) return;

    const utter = new SpeechSynthesisUtterance(line.text);
    // Best-effort voice pick. Browsers vary in what they ship; if we
    // don't find one matching the lang, the default voice speaks — the
    // pronunciation is off but the words land.
    const voices = synth.getVoices();
    const match = voices.find((v) => v.lang.toLowerCase().startsWith(line.lang));
    if (match) utter.voice = match;
    utter.rate = 1.05;
    utter.pitch = 1;
    utter.volume = 1;
    try {
      synth.speak(utter);
    } catch {
      /* browsers occasionally throw on rapid speak; skip */
    }
  }, [active, muted, line]);

  if (!active || !line) return null;

  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-14 flex justify-center">
      <div className="max-w-[min(720px,92%)] rounded-md border border-white/12 bg-black/70 px-4 py-2 text-center backdrop-blur">
        <p className="text-sm text-white/95 sm:text-base">{line.text}</p>
      </div>
    </div>
  );
}
