// src/components/NeoMark.tsx
//
// The NeoConference mark: a navy "N" whose right stroke is teal above the
// diagonal, with a camera lens beside it — the same shapes as the favicon
// (public/apple-touch-icon.png) and the Android app icon. The outline is
// shared with mobile/tool/launcher_icon.mjs, which draws the app icon, and
// with NeoLogoMark in the app (mobile/lib/src/design/brand.dart); change
// all three together. Coordinates are that 180px favicon's pixels.

const N =
  "M61,68 H74.5 L85.5,78.45 V68 H98 A5,5 0 0 1 103,73 V108 A5,5 0 0 1 98,113 " +
  "H88 L74.5,100 V108 A5,5 0 0 1 69.5,113 H61 A5,5 0 0 1 56,108 V73 A5,5 0 0 1 61,68 Z";

export default function NeoMark({ className }: { className?: string }) {
  return (
    // viewBox: the mark's own bounds, lens stroke included.
    <svg viewBox="55 67 70.5 47" className={className} aria-hidden>
      <defs>
        <clipPath id="neo-mark-n">
          <path d={N} />
        </clipPath>
      </defs>
      <path d={N} fill="#01183A" />
      <polygon points="85.5,60 110,60 110,101.7 85.5,78.45" fill="#0C7AAA" clipPath="url(#neo-mark-n)" />
      <polygon
        points="108.5,81.5 122.5,74.5 122.5,106.5 108.5,99.5"
        fill="#01183A"
        stroke="#01183A"
        strokeWidth={4}
        strokeLinejoin="round"
      />
    </svg>
  );
}
