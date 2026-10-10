"use client";

import { useEffect, useRef, useState } from "react";

interface Ready {
  summary: string;
  points: string[];
  minutes: number;
  at: number;
}

/**
 * "What did I miss?" — for someone who joins a programme late: a short
 * summary of what has been said so far, in the language they picked, which
 * the browser can read aloud. The summary is shared and refreshed every
 * couple of minutes on the server (src/lib/catchUp.ts).
 */
export default function CatchUp({ room, lang, label }: { room: string; lang: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "nothing" | "failed">("idle");
  const [data, setData] = useState<Ready | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const tries = useRef(0);
  const asked = useRef<string>("");

  const stopSpeaking = () => {
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* no speech in this browser */
    }
    setSpeaking(false);
  };

  const load = async () => {
    setState("loading");
    asked.current = lang;
    try {
      const r = await fetch(`/api/video/catchup?room=${encodeURIComponent(room)}&lang=${encodeURIComponent(lang)}`, {
        cache: "no-store",
      });
      const j = (await r.json()) as { ok?: boolean; status?: string } & Partial<Ready>;
      if (asked.current !== lang) return;
      if (j.status === "ready" && j.summary) {
        tries.current = 0;
        setData({ summary: j.summary, points: j.points ?? [], minutes: j.minutes ?? 0, at: j.at ?? Date.now() });
        setState("ready");
      } else if (j.status === "busy" && tries.current < 6) {
        // Someone else's request is making it right now; it is ready in seconds.
        tries.current += 1;
        setTimeout(() => void load(), 3000);
      } else if (j.status === "nothing_yet") {
        setState("nothing");
      } else {
        setState("failed");
      }
    } catch {
      setState("failed");
    }
  };

  // Another language picked while open: fetch that one.
  useEffect(() => {
    if (!open) return;
    stopSpeaking();
    tries.current = 0;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, open]);

  useEffect(() => () => stopSpeaking(), []);

  const speak = () => {
    if (!data) return;
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth) return;
    if (speaking) {
      stopSpeaking();
      return;
    }
    const u = new SpeechSynthesisUtterance([data.summary, ...data.points].join(". "));
    u.lang = lang;
    const voice = synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith(lang.split("-")[0]));
    if (voice) u.voice = voice;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    synth.cancel();
    synth.speak(u);
    setSpeaking(true);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2.5 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-500/20"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
        What did I miss?
      </button>
    );
  }

  return (
    <section
      aria-label="What did I miss?"
      className="flex flex-col gap-3 rounded-lg border border-cyan-400/30 bg-[#0d1a22] p-4"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-cyan-200/80">
          What did I miss? · {label}
        </span>
        <button
          type="button"
          onClick={() => {
            stopSpeaking();
            setOpen(false);
          }}
          aria-label="Close"
          className="ml-auto rounded-md px-2 py-0.5 text-white/60 hover:bg-white/10 hover:text-white"
        >
          ✕
        </button>
      </div>

      {state === "loading" && <p className="text-sm text-white/60">Catching you up…</p>}
      {state === "nothing" && (
        <p className="text-sm text-white/70">Nothing has been said yet. Check again once the programme is under way.</p>
      )}
      {state === "failed" && (
        <p className="text-sm text-white/70">
          The summary is not available right now.{" "}
          <button type="button" onClick={() => void load()} className="underline underline-offset-2 hover:text-white">
            Try again
          </button>
        </p>
      )}

      {state === "ready" && data && (
        <>
          <p className="text-[15px] leading-relaxed text-white/90">{data.summary}</p>
          {data.points.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-white/80">
              {data.points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={speak}
              className="flex items-center gap-1.5 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-white/85 hover:bg-white/10"
            >
              {speaking ? "Stop" : "Listen"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md px-3 py-1.5 text-sm text-white/60 hover:bg-white/5 hover:text-white"
            >
              Refresh
            </button>
            <span className="ml-auto font-mono text-[10.5px] text-white/40">
              Covers {data.minutes} min so far · updated{" "}
              {new Date(data.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
          <p className="text-[11px] text-white/35">Made by AI from the live captions; it may contain mistakes.</p>
        </>
      )}
    </section>
  );
}
