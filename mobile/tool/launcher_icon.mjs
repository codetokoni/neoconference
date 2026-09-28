// Draws the NeoConference launcher icon for Android from vector shapes and
// writes every density Android asks for.
//
// The only copy of the logo in the repo is the website's 180px
// apple-touch-icon (public/apple-touch-icon.png) — too small to upscale
// cleanly to a 432px adaptive-icon layer. So the mark is redrawn here from
// measurements of that image: the same gradient tile, the navy "N" whose
// right stroke is teal, and the camera lens beside it. Coordinates are in
// that image's pixels, so a change can be checked against it directly.
//
// Run from mobile/:  node tool/launcher_icon.mjs
// (uses sharp from the web app's node_modules)

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'package.json'));
const sharp = require('sharp');

const NAVY = '#01183A';
const TEAL = '#0C7AAA';
const GRADIENT = `
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#A5FBF9"/>
    <stop offset="0.5" stop-color="#56D2FB"/>
    <stop offset="1" stop-color="#1F66FB"/>
  </linearGradient>`;

// The mark, in the source image's pixels. Its centre is (90.25, 90.5).
// Also drawn by src/components/NeoMark.tsx (the website header) and
// NeoLogoMark in mobile/lib/src/design/brand.dart; change all three together.
//
// The N is one outline — two strokes and the diagonal between them, with
// rounded outer corners. Pieces laid side by side leave hairline seams.
// Its diagonal edges run at a slope of 0.95.
const N = `M61,68 H74.5 L85.5,78.45 V68 H98 A5,5 0 0 1 103,73 V108 A5,5 0 0 1 98,113
  H88 L74.5,100 V108 A5,5 0 0 1 69.5,113 H61 A5,5 0 0 1 56,108 V73 A5,5 0 0 1 61,68 Z`;

const GLYPH = `
  <clipPath id="n"><path d="${N}"/></clipPath>
  <path d="${N}" fill="${NAVY}"/>
  <!-- The right stroke above the diagonal is teal. -->
  <polygon points="85.5,60 110,60 110,101.7 85.5,78.45" fill="${TEAL}" clip-path="url(#n)"/>
  <polygon points="108.5,81.5 122.5,74.5 122.5,106.5 108.5,99.5"
           fill="${NAVY}" stroke="${NAVY}" stroke-width="4" stroke-linejoin="round"/>`;

const CX = 90.25;
const CY = 90.5;

/** The mark alone, centred on a [size] canvas, [scale] source px per output px. */
function glyphLayer(size, markWidth) {
  const k = markWidth / 68.5; // the mark is 68.5 source px wide
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>${GRADIENT}</defs>
    <g transform="translate(${size / 2} ${size / 2}) scale(${k}) translate(${-CX} ${-CY})">${GLYPH}</g>
  </svg>`;
}

/** The whole tile: gradient square with rounded corners, mark on it. */
function tile(size, { round = false } = {}) {
  const inset = size * 0.04;
  const w = size - inset * 2;
  const shape = round
    ? `<circle cx="${size / 2}" cy="${size / 2}" r="${w / 2}" fill="url(#g)"/>`
    : `<rect x="${inset}" y="${inset}" width="${w}" height="${w}" rx="${w * 0.26}" fill="url(#g)"/>`;
  const k = (w * 0.5) / 68.5; // the mark is half the tile's width, as on the website
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>${GRADIENT}</defs>
    ${shape}
    <g transform="translate(${size / 2} ${size / 2}) scale(${k}) translate(${-CX} ${-CY})">${GLYPH}</g>
  </svg>`;
}

function background(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>${GRADIENT}</defs><rect width="${size}" height="${size}" fill="url(#g)"/>
  </svg>`;
}

const res = join(here, '..', 'android', 'app', 'src', 'main', 'res');
// Legacy icon is 48dp; adaptive layers are 108dp, with the launcher showing
// roughly the middle 72dp. The mark takes about half of that visible 72dp, as it
// takes half the tile on the website.
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

async function png(svg, path) {
  mkdirSync(dirname(path), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(path);
}

for (const [name, d] of Object.entries(densities)) {
  const dir = join(res, `mipmap-${name}`);
  await png(tile(48 * d), join(dir, 'ic_launcher.png'));
  await png(tile(48 * d, { round: true }), join(dir, 'ic_launcher_round.png'));
  await png(glyphLayer(108 * d, 38 * d), join(dir, 'ic_launcher_foreground.png'));
  await png(background(108 * d), join(dir, 'ic_launcher_background.png'));
}

const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
mkdirSync(join(res, 'mipmap-anydpi-v26'), { recursive: true });
writeFileSync(join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive);
writeFileSync(join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptive);

// A large copy beside the website's, for checking the drawing by eye.
if (process.argv.includes('--preview')) {
  const out = process.argv[process.argv.indexOf('--preview') + 1];
  await png(tile(512), out);
}
