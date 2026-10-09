// src/components/BrandMark.tsx
//
// The NeoConference logo as the site header draws it — the gradient tile
// with the mark, then the wordmark — for laying over full-screen video
// (Spotlight, a player in fullscreen), where the header is out of sight.
// Not interactive: it never takes a click meant for the video.

import NeoMark from "./NeoMark";

export default function BrandMark({ className = "" }: { className?: string }) {
  return (
    <div
      aria-label="NeoConference"
      className={
        "pointer-events-none inline-flex select-none items-center gap-2.5 rounded-xl bg-black/35 px-2.5 py-1.5 backdrop-blur-sm " +
        className
      }
    >
      <span className="relative inline-flex h-8 w-8 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#A5FBF9_0%,#56D2FB_50%,#1F66FB_100%)] shadow-[0_0_24px_rgba(34,211,238,0.55)]">
        <span className="absolute inset-0 rounded-xl ring-1 ring-white/30" />
        <NeoMark className="w-4" />
      </span>
      <span className="text-[17px] font-semibold tracking-tight text-cyan-100">
        Neo<span className="neo-gradient-text">Conference</span>
      </span>
    </div>
  );
}
