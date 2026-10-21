// The NeoLinguaMeet logo and name, always on show in a partner's embed:
// in the meeting (above "Your Prayer Time") and on every screen around it.
// The same tile and wordmark as the site header (src/app/layout.tsx).

import NeoMark from "@/components/NeoMark";
import { BRAND } from "@/lib/brand";

export function EmbedBrand({ size = "sm" }: { size?: "sm" | "md" }) {
  const tile = size === "md" ? "h-7 w-7 rounded-lg" : "h-6 w-6 rounded-md";
  return (
    <a
      href={BRAND.origin}
      target="_blank"
      rel="noopener"
      title={`${BRAND.name}: video meetings with live translation`}
      className="nlm-embed-brand inline-flex items-center gap-2 rounded-xl px-2 py-1 no-underline"
      style={{
        background: "rgba(11,16,32,0.8)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: "1px solid rgba(255,255,255,0.1)",
        pointerEvents: "auto",
      }}
    >
      <span className={`relative inline-flex ${tile} items-center justify-center bg-[linear-gradient(135deg,#A5FBF9_0%,#56D2FB_50%,#1F66FB_100%)]`}>
        <span className="absolute inset-0 rounded-[inherit] ring-1 ring-white/30" />
        <NeoMark className={size === "md" ? "w-3.5" : "w-3"} />
      </span>
      <span className={`font-semibold tracking-tight text-cyan-100 ${size === "md" ? "text-[15px]" : "text-[13px]"}`}>
        {BRAND.nameHead}
        <span className="neo-gradient-text">{BRAND.nameTail}</span>
      </span>
    </a>
  );
}
