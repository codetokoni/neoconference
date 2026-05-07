// src/app/api/qr/[slug]/route.ts
// Local QR generation for any NeoConference event slug.
// Returns a PNG by default, or SVG when ?format=svg is passed.
//
// Q-Scan / QRForge does not expose a public API, so we generate the QR
// in-process with the qrcode npm package and serve it from our edge.

import { NextRequest, NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { eventStore } from '@/lib/eventStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function originFrom(req: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return env.replace(/\/+$/, '');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('host') ?? 'localhost:3000';
  return proto + '://' + host;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { slug: string } }
) {
  const slug = params.slug;
  const url = new URL(req.url);
  const format = (url.searchParams.get('format') ?? 'png').toLowerCase();
  const sizeStr = url.searchParams.get('size') ?? '512';
  const size = Math.max(128, Math.min(2048, Number(sizeStr) || 512));

  // Optional: route to short link if HSMOH is configured and event has one,
  // otherwise use our native /e/<slug> resolver.
  const ev = await eventStore.bySlug(slug).catch(() => null);
  const target =
    ev?.hsmoh?.shortUrl ??
    originFrom(req) + '/e/' + encodeURIComponent(slug);

  try {
    if (format === 'svg') {
      const svg = await QRCode.toString(target, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 1,
        color: { dark: '#0a0f1a', light: '#ffffff' },
        width: size,
      });
      return new NextResponse(svg, {
        status: 200,
        headers: {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=300, s-maxage=600',
        },
      });
    }

    const buf = await QRCode.toBuffer(target, {
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#0a0f1a', light: '#ffffff' },
      width: size,
    });
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=300, s-maxage=600',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'qr_generation_failed', detail: String(e) },
      { status: 500 }
    );
  }
}
