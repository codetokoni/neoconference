"use client";

// src/components/MeetingCatchUp.tsx
//
// "What did I miss?" in a meeting: a toolbar button that opens the shared
// catch-up panel over the room, in a language the viewer picks (starting from
// the one chosen under "Hear this meeting in"). The summary comes from the
// meeting's caption transcript, so it covers the time captions were on.

import { useState } from "react";
import { createPortal } from "react-dom";
import { useRoomContext } from "@livekit/components-react";
import CatchUp from "@/components/video/CatchUp";
import { TRANSLATION_LANGUAGES } from "@/lib/translationLanguages";

const TOOLBAR_BTN_CLASS =
  "inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-transparent px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/10 hover:border-white/25 active:scale-[0.98] transition";

const LANGS = [{ code: "en", label: "English" }, ...TRANSLATION_LANGUAGES.filter((l) => l.code !== "en")];

function startingLang(roomName: string): string {
  try {
    const picked = window.sessionStorage.getItem("neo:translation:target:" + roomName);
    if (picked && picked !== "off" && LANGS.some((l) => l.code === picked)) return picked;
  } catch {
    /* no storage */
  }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  return LANGS.find((l) => l.code === nav)?.code ?? LANGS.find((l) => l.code === nav.split("-")[0])?.code ?? "en";
}

export default function MeetingCatchUp() {
  const room = useRoomContext();
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState("en");

  if (!room?.name) return null;
  const label = LANGS.find((l) => l.code === lang)?.label ?? lang;

  return (
    <>
      <button
        type="button"
        className={TOOLBAR_BTN_CLASS}
        onClick={() => {
          if (!open) setLang(startingLang(room.name));
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        title="A summary of the meeting so far, in your language"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
        What did I miss?
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed bottom-24 left-1/2 z-[200] flex w-[min(520px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2 rounded-xl border border-white/10 bg-[#0b1020]/95 p-3 shadow-2xl backdrop-blur">
            <label className="flex items-center gap-2 text-xs text-white/60">
              Language
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-white/15 bg-[#0B1319] px-2 py-1 text-sm text-white"
              >
                {LANGS.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <CatchUp
              src={`/api/meeting-catchup?room=${encodeURIComponent(room.name)}`}
              lang={lang}
              label={label}
              startOpen
              onClose={() => setOpen(false)}
              emptyText="Nothing to catch up on yet. This works while captions are on — ask the host to turn on captions."
            />
          </div>,
          document.body,
        )}
    </>
  );
}
