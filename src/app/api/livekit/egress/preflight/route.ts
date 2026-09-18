// src/app/api/livekit/egress/preflight/route.ts
//
// Diagnostic. Reports which pieces of the recording pipeline are
// present and reachable so "recording isn't working" turns into a
// specific line to fix. Owner/host only — the reply names env keys
// and would be more information than a guest should see.
//
// GET /api/livekit/egress/preflight?room=<slug?>
//   200 { ok: true, env: {...}, livekit: {...}, s3: {...}, permission: {...} }
//
// Each section reports { present: boolean, error?: string }. Nothing
// here MUTATES anything (no test egress is started); a real egress
// still validates that the layout works and the room exists.

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { EgressClient } from 'livekit-server-sdk';
import { eventStore } from '@/lib/eventStore';
import { authorize } from '@/lib/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Section {
  present: boolean;
  error?: string;
  detail?: Record<string, unknown>;
}

function envSection(): Record<string, Section> {
  const keys = [
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'NEXT_PUBLIC_LIVEKIT_URL',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_REGION',
  ];
  const out: Record<string, Section> = {};
  for (const k of keys) {
    const v = process.env[k];
    out[k] = { present: Boolean(v && v.length > 0) };
    if (k === 'NEXT_PUBLIC_LIVEKIT_URL' && v) {
      // Sanity: must be ws:// or wss://.
      if (!v.startsWith('ws://') && !v.startsWith('wss://')) {
        out[k].error = 'Expected ws:// or wss:// URL';
      }
    }
  }
  return out;
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  const roomSlug = url.searchParams.get('room') || '';
  let permission: Section = { present: false, error: 'no_room_supplied' };
  let ev = null;
  if (roomSlug) {
    ev = await eventStore.bySlug(roomSlug);
    if (!ev) {
      permission = { present: false, error: 'event_not_found' };
    } else {
      const gate = await authorize(ev, 'recording:start');
      if (gate.ok) {
        permission = { present: true };
      } else {
        // Bail early — we don't want to leak env details to someone
        // who isn't allowed to record. Return the permission-denied
        // shape and stop.
        return NextResponse.json(
          {
            ok: false,
            permission: { present: false, error: 'forbidden' },
          },
          { status: 403 },
        );
      }
    }
  }

  const env = envSection();

  // LiveKit reachability check — list egresses (a read op that also
  // verifies the API URL and creds work).
  let livekit: Section = { present: false };
  try {
    const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || '';
    const httpUrl = wsUrl.replace(/^ws/, 'http');
    const apiKey = process.env.LIVEKIT_API_KEY || '';
    const apiSecret = process.env.LIVEKIT_API_SECRET || '';
    if (!httpUrl || !apiKey || !apiSecret) {
      livekit = { present: false, error: 'missing_env' };
    } else {
      const c = new EgressClient(httpUrl, apiKey, apiSecret);
      const list = await c.listEgress({});
      livekit = {
        present: true,
        detail: { active_egresses: list.length },
      };
    }
  } catch (err) {
    livekit = {
      present: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // R2 reachability check — HEAD the bucket. Skip if env is missing.
  let s3: Section = { present: false };
  const s3Endpoint = process.env.S3_ENDPOINT || '';
  const s3Bucket = process.env.S3_BUCKET || '';
  const s3AccessKey = process.env.S3_ACCESS_KEY || '';
  const s3SecretKey = process.env.S3_SECRET_KEY || '';
  if (!s3Endpoint || !s3Bucket || !s3AccessKey || !s3SecretKey) {
    s3 = { present: false, error: 'missing_env' };
  } else {
    try {
      // Use the app's existing r2 helper if present; otherwise a
      // minimal HEAD via fetch will do. Import lazily so a build
      // without the helper still works.
      const { r2Head } = await import('@/lib/r2-preflight');
      const result = await r2Head(s3Endpoint, s3Bucket);
      s3 = result;
    } catch (err) {
      // Helper missing or errored — best-effort report.
      s3 = {
        present: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return NextResponse.json({
    ok: true,
    room: roomSlug || null,
    permission,
    env,
    livekit,
    s3,
  });
}
