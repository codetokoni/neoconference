// Draws the NeoLinguaMeet website icons from vector shapes into
// public/brand/neolinguameet/. next.config.mjs serves them in place of the
// NeoConference ones (/favicon.ico, /icon.png, /apple-touch-icon.png,
// /icons/*) once NEXT_PUBLIC_PRIMARY_DOMAIN is neolinguameet.com.
//
// Same sizes and styles as the NeoConference set they replace:
//   icon-192 / icon-512   full-bleed gradient square (PWA, maskable)
//   apple-touch-icon      180px full-bleed square (iOS rounds it itself)
//   icon                  96px rounded tile, transparent corners (favicon)
//   badge-96              white silhouette (Android notification badge)
//   favicon.ico           16, 32 and 48px rounded tiles
//
// Run from mobile/:  node tool/web_icons.mjs
// (uses sharp from the web app's node_modules)

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GRADIENT, LINGUA_GLYPH, LINGUA_CX, LINGUA_CY, LINGUA_WIDTH, linguaSilhouette } from './neo_mark.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'package.json'));
const sharp = require('sharp');
const out = join(here, '..', '..', 'public', 'brand', 'neolinguameet');

/** The mark centred on a [size] canvas, [frac] of its width. */
function placed(glyph, size, frac) {
  const k = (size * frac) / LINGUA_WIDTH;
  return `<g transform="translate(${size / 2} ${size / 2}) scale(${k}) translate(${-LINGUA_CX} ${-LINGUA_CY})">${glyph}</g>`;
}

function square(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>${GRADIENT}</defs>
    <rect width="${size}" height="${size}" fill="url(#g)"/>
    ${placed(LINGUA_GLYPH, size, 0.5)}
  </svg>`;
}

function roundTile(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>${GRADIENT}</defs>
    <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="url(#g)"/>
    ${placed(LINGUA_GLYPH, size, size <= 32 ? 0.66 : 0.56)}
  </svg>`;
}

function badge(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    ${placed(linguaSilhouette('#ffffff'), size, 0.78)}
  </svg>`;
}

const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();

/** An .ico holding PNG images, which every current browser reads. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

mkdirSync(out, { recursive: true });
const files = {
  'icon-192.png': await png(square(192)),
  'icon-512.png': await png(square(512)),
  'apple-touch-icon.png': await png(square(180)),
  'icon.png': await png(roundTile(96)),
  'badge-96.png': await png(badge(96)),
};
files['favicon.ico'] = ico(
  await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(roundTile(size)) }))),
);
// The logo on its own, for documents and the store listing.
files['logo.svg'] = Buffer.from(roundTile(512).replace(/width="512" height="512"/, 'width="512" height="512" viewBox="0 0 512 512"'));

for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(out, name), data);
  console.log(`${name}  ${data.length} bytes`);
}
