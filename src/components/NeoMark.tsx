// src/components/NeoMark.tsx
//
// The product's mark, drawn on the gradient tile. Both share the navy "N"
// whose right stroke is teal above the diagonal:
//   NeoConference  — a camera lens beside it (a video camera);
//   NeoLinguaMeet  — two speech bubbles beside it, teal over navy: two
//                    people talking, each in their own language.
// The same shapes as the favicon and the Android app icon. The outline is
// shared with mobile/tool/neo_mark.mjs, which draws the app and web icons,
// and with NeoLogoMark in the app (mobile/lib/src/design/brand.dart);
// change them together. Coordinates are the 180px favicon's pixels.

import { BRAND } from "@/lib/brand";

const N =
  "M61,68 H74.5 L85.5,78.45 V68 H98 A5,5 0 0 1 103,73 V108 A5,5 0 0 1 98,113 " +
  "H88 L74.5,100 V108 A5,5 0 0 1 69.5,113 H61 A5,5 0 0 1 56,108 V73 A5,5 0 0 1 61,68 Z";

/** NeoLinguaMeet: the upper bubble's tail points back at the N, the lower one's away. */
const BUBBLE_TOP = "M112,68 H123 A4,4 0 0 1 127,72 V82 A4,4 0 0 1 123,86 H117 L112,90.5 V86 A4,4 0 0 1 108,82 V72 A4,4 0 0 1 112,68 Z";
const BUBBLE_BOTTOM =
  "M112,95 H123 A4,4 0 0 1 127,99 V109 A4,4 0 0 1 123,113 H112 A4,4 0 0 1 108,109 V99 A4,4 0 0 1 112,95 Z M127,109 L127,117 L121.5,113 Z";

export default function NeoMark({ className }: { className?: string }) {
  const lingua = BRAND.id === "neolinguameet";
  return (
    // viewBox: the mark's own bounds, lens stroke or bubble tail included.
    <svg viewBox={lingua ? "55 67 73 51" : "55 67 70.5 47"} className={className} aria-hidden>
      <defs>
        <clipPath id="neo-mark-n">
          <path d={N} />
        </clipPath>
      </defs>
      <path d={N} fill="#01183A" />
      <polygon points="85.5,60 110,60 110,101.7 85.5,78.45" fill="#0C7AAA" clipPath="url(#neo-mark-n)" />
      {lingua ? (
        <>
          <path d={BUBBLE_TOP} fill="#0C7AAA" />
          <path d={BUBBLE_BOTTOM} fill="#01183A" />
        </>
      ) : (
        <polygon
          points="108.5,81.5 122.5,74.5 122.5,106.5 108.5,99.5"
          fill="#01183A"
          stroke="#01183A"
          strokeWidth={4}
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
