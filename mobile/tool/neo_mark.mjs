// The NeoConference mark as SVG pieces, shared by the scripts that draw it:
// launcher_icon.mjs (the Android app icon) and store_assets.mjs (the Play
// Store icon and feature graphic).
//
// Coordinates are the website's 180px apple-touch-icon's pixels. Also drawn
// by src/components/NeoMark.tsx (the website header) and NeoLogoMark in
// mobile/lib/src/design/brand.dart; change all three together.

export const NAVY = '#01183A';
export const TEAL = '#0C7AAA';

export const GRADIENT = `
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#A5FBF9"/>
    <stop offset="0.5" stop-color="#56D2FB"/>
    <stop offset="1" stop-color="#1F66FB"/>
  </linearGradient>`;

// The N is one outline — two strokes and the diagonal between them, with
// rounded outer corners. Pieces laid side by side leave hairline seams.
// Its diagonal edges run at a slope of 0.95.
const N = `M61,68 H74.5 L85.5,78.45 V68 H98 A5,5 0 0 1 103,73 V108 A5,5 0 0 1 98,113
  H88 L74.5,100 V108 A5,5 0 0 1 69.5,113 H61 A5,5 0 0 1 56,108 V73 A5,5 0 0 1 61,68 Z`;

export const GLYPH = `
  <clipPath id="n"><path d="${N}"/></clipPath>
  <path d="${N}" fill="${NAVY}"/>
  <!-- The right stroke above the diagonal is teal. -->
  <polygon points="85.5,60 110,60 110,101.7 85.5,78.45" fill="${TEAL}" clip-path="url(#n)"/>
  <polygon points="108.5,81.5 122.5,74.5 122.5,106.5 108.5,99.5"
           fill="${NAVY}" stroke="${NAVY}" stroke-width="4" stroke-linejoin="round"/>`;

/** The mark's centre, and its width, in those source pixels. */
export const CX = 90.25;
export const CY = 90.5;
export const MARK_WIDTH = 68.5;
