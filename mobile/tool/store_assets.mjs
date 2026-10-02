// Draws the Google Play listing's graphics from the same mark as the app
// icon (neo_mark.mjs):
//
//   icon-512.png              the store icon: 512×512, full-bleed (Play
//                             rounds the corners itself)
//   feature-graphic.png       1024×500, no transparency
//
// Run from mobile/:  node tool/store_assets.mjs <out-dir>
// (uses sharp from the web app's node_modules)

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRADIENT, GLYPH, CX, CY, MARK_WIDTH } from './neo_mark.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'package.json'));
const sharp = require('sharp');

const out = process.argv[2];
if (!out) {
  console.error('usage: node tool/store_assets.mjs <out-dir>');
  process.exit(1);
}
mkdirSync(out, { recursive: true });

/** The mark, [width] px wide, centred on (x, y). */
const mark = (x, y, width) =>
  `<g transform="translate(${x} ${y}) scale(${width / MARK_WIDTH}) translate(${-CX} ${-CY})">${GLYPH}</g>`;

// Full bleed: Play masks the icon to its own rounded square, so corners or
// a shadow drawn here would be cut or doubled. The mark takes half the
// width, as on the launcher tile.
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <defs>${GRADIENT}</defs>
  <rect width="512" height="512" fill="url(#g)"/>
  ${mark(256, 256, 256)}
</svg>`;

// The website's colours: deep navy, the brand gradient on the tile, the
// cyan accent. Play may crop the edges and lay its own play button over
// the middle on some surfaces, so the words sit left of centre with room
// around them.
const FONT = "'Segoe UI', Arial, sans-serif";
const feature = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500">
  <defs>
    ${GRADIENT}
    <radialGradient id="glow" cx="0.82" cy="0.2" r="0.75">
      <stop offset="0" stop-color="#22D3EE" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#22D3EE" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0.1" cy="1" r="0.7">
      <stop offset="0" stop-color="#A855F7" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#A855F7" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="500" fill="#060B1A"/>
  <rect width="1024" height="500" fill="url(#glow)"/>
  <rect width="1024" height="500" fill="url(#glow2)"/>
  <rect x="84" y="150" width="200" height="200" rx="52" fill="url(#g)"/>
  ${mark(184, 250, 104)}
  <text x="330" y="222" font-family="${FONT}" font-size="64" font-weight="700" fill="#FFFFFF">NeoConference</text>
  <text x="332" y="282" font-family="${FONT}" font-size="34" font-weight="600" fill="#67E8F9">One meeting. Every language.</text>
  <text x="332" y="330" font-family="${FONT}" font-size="24" fill="#B6C2D9">Video meetings with live translation</text>
</svg>`;

await sharp(Buffer.from(icon)).png().toFile(join(out, 'icon-512.png'));
await sharp(Buffer.from(feature)).flatten({ background: '#060B1A' }).png().toFile(join(out, 'feature-graphic.png'));
console.log('wrote', join(out, 'icon-512.png'), 'and', join(out, 'feature-graphic.png'));
