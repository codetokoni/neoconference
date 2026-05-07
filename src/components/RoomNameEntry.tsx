"use client";
import { useEffect, useRef, useState } from "react";

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!getSavedDisplayName() && defaultName) setName(defaultName);
  }, [defaultName]);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = name.trim() || defaultName || "Guest";
    saveDisplayName(trimmed);
    onSubmit({ username: trimmed, videoEnabled: video, audioEnabled: audio });
  };

  return (
    <div className="fixed inset-0 z-30 overflow-hidden bg-[#040713] text-white">
      <div aria-hidden className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-40 -left-40 w-[40rem] h-[40rem] rounded-full bg-cyan-500/20 blur-3xl animate-pulse" />
        <div className="absolute -bottom-40 -right-40 w-[40rem] h-[40rem] rounded-full bg-fuchsia-500/10 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(34,211,238,0.08),transparent_60%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent,rgba(0,0,0,0.4))]" />
      </div>

      <div className="relative h-full w-full flex items-center justify-center px-4 py-10 overflow-y-auto">
        <form onSubmit={submit} className="w-full max-w-xl rounded-3xl border border-cyan-400/20 bg-zinc-950/60 backdrop-blur-xl shadow-[0_0_60px_rgba(34,211,238,0.15)] p-8 md:p-10">
          <div className="flex items-center justify-between mb-6 gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.3em] text-cyan-400/80">Room</div>
              <div className="text-2xl md:text-3xl font-bold text-white truncate">{roomName}</div>
            </div>
            <button type="button" onClick={onCopyLink} className="text-xs px-3 py-1.5 rounded-full border border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/10 transition">
              {copied ? "Copied!" : "Copy link"}
            </button>
          </div>

          <label className="block text-xs uppercase tracking-[0.25em] text-cyan-400/70 mb-2">Your name</label>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter your name"
            className="w-full px-4 py-3 mb-6 rounded-xl bg-black/60 border border-white/10 focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-400/30 text-lg placeholder:text-zinc-500 transition"
          />

          <div className="grid grid-cols-2 gap-3 mb-8">
            <ToggleTile label="Camera" on={video} onChange={setVideo} icon="video" />
            <ToggleTile label="Microphone" on={audio} onChange={setAudio} icon="mic" />
          </div>

          <button type="submit" className="w-full py-3.5 rounded-xl bg-gradient-to-r from-cyan-400 to-cyan-500 hover:from-cyan-300 hover:to-cyan-400 text-black font-bold text-lg tracking-wide shadow-[0_0_30px_rgba(34,211,238,0.4)] transition active:scale-[0.99]">
            Join Room →
          </button>
          <p className="text-center text-xs text-zinc-500 mt-4">Your name is saved for future sessions.</p>
        </form>
      </div>
    </div>
  );
}

function ToggleTile({ label, on, onChange, icon }: { label: string; on: boolean; onChange: (v: boolean) => void; icon: "video" | "mic" }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border transition ${on ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/10 bg-black/40 text-zinc-400"}`}>
      <span className="flex items-center gap-2">
        <span aria-hidden className="text-lg">{icon === "video" ? (on ? "🎥" : "📷") : (on ? "🎤" : "🔇")}</span>
        <span className="text-sm font-medium">{label}</span>
      </span>
      <span className={`relative w-9 h-5 rounded-full transition ${on ? "bg-cyan-400" : "bg-white/10"}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition ${on ? "left-[18px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

export default RoomNameEntry;
