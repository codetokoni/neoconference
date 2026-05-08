'use client';

// src/components/CaptionLanguagePicker.tsx
//
// Floating dropdown that lets viewers pick a caption locale. The choice is
// stored in localStorage under CAPTION_LOCALE_STORAGE_KEY and the active
// LiveCaptions overlay reads it and filters TranscriptionSegments by
// segment.language. Defaults to "auto" (no filtering).

import { useEffect, useState } from "react";
import { CAPTION_LOCALES, CAPTION_LOCALE_STORAGE_KEY, isKnownCaptionLocale } from "@/lib/locales";

export default function CaptionLanguagePicker() {
  const [code, setCode] = useState<string>("auto");
  const [open, setOpen] = useState<boolean>(false);

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(CAPTION_LOCALE_STORAGE_KEY);
      if (isKnownCaptionLocale(v)) setCode(v as string);
    } catch {}
  }, []);

  const choose = (next: string) => {
    setCode(next);
    setOpen(false);
    try {
      window.localStorage.setItem(CAPTION_LOCALE_STORAGE_KEY, next);
      window.dispatchEvent(new CustomEvent("neo:captions-locale-changed", { detail: next }));
    } catch {}
  };

  const active = CAPTION_LOCALES.find((l) => l.code === code) || CAPTION_LOCALES[0];

  return (
    <div className="fixed bottom-4 right-4 z-40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="rounded-full bg-black/60 hover:bg-black/80 backdrop-blur border border-white/15 text-white/90 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] flex items-center gap-2 shadow-[0_4px_24px_rgba(0,0,0,0.4)]">
        <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_2px_rgba(34,211,238,0.7)]" />
        <span>Captions: {active.label}</span>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute right-0 bottom-[calc(100%+0.5rem)] w-56 max-h-72 overflow-auto rounded-xl border border-white/10 bg-black/85 backdrop-blur-xl text-white/90 shadow-[0_24px_80px_rgba(0,0,0,0.6)] py-1">
          {CAPTION_LOCALES.map((l) => (
            <li
              role="option"
              key={l.code}
              aria-selected={l.code === code}
              onClick={() => choose(l.code)}
              className={(l.code === code ? "bg-cyan-500/15 text-cyan-200 " : "hover:bg-white/5 ") + "cursor-pointer px-3 py-2 text-[12px] flex items-center justify-between"}
            >
              <span>{l.native}</span>
              <span className="text-[10px] uppercase tracking-[0.14em] text-white/50 font-mono">{l.code}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
