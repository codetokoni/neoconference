import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createStream, isStreamLabConfigured } from '@/lib/streamlab';

export const runtime = 'nodejs';

/**
 * POST /api/golive
 *
 * Provisions an ad-hoc StreamLab broadcast bound to a room.
 * Returns RTMP ingest credentials + HLS playback URL.
 *
 * Body: { roomName: string, title?: string }
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  if (!isStreamLabConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'StreamLab is not configured. Set STREAMLAB_API_KEY in environment.' },
      { status: 503 }
    );
  }

  let body: { roomName?: string; title?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const roomName = (body.roomName || '').trim();
  if (!roomName) {
    return NextResponse.json({ ok: false, error: 'roomName required' }, { status: 400 });
  }

  const name = (body.title || roomName).slice(0, 80);

  try {
    const stream = await createStream({ name, mode: 'single', latency: 'hls' });
    return NextResponse.json({
      ok: true,
      stream: {
        id: stream.id,
        rtmpUrl: stream.rtmpUrl,
        streamKey: stream.streamKey,
        hlsUrl: stream.hlsUrl,
        playbackId: stream.playbackId,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}

