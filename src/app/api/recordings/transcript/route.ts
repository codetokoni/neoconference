// src/app/api/recordings/transcript/route.ts
//
// GET /api/recordings/transcript?key=<r2-object-key>
//
// Returns the persisted Deepgram transcript for a recording as a plain-text
// download. Authenticated; the requesting user must own the recording (its
// R2 key must live under their per-user prefix). When the job has a summary,
// it is prepended above the transcript so a single .txt file carries both.

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { transcribeStore } from '@/lib/transcribeStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sanitizeSegment(s: string): string {
  return (s || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'x';
}

function userPrefix(userId: string): string {
  return 'recordings/' + sanitizeSegment(userId) + '/';
}

function basenameNoExt(key: string): string {
  const last = key.split('/').pop() || key;
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const key = (req.nextUrl.searchParams.get('key') || '').trim();
  if (!key || key.length > 512 || key.includes('..')) {
    return NextResponse.json({ ok: false, error: 'missing-or-invalid-key' }, { status: 400 });
  }
  if (!key.startsWith(userPrefix(userId))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const job = await transcribeStore.getByRecordingKey(key);
  if (!job || job.status !== 'done' || !job.text) {
    return NextResponse.json(
      { ok: false, error: 'transcript_not_available' },
      { status: 404 }
    );
  }

  const parts: string[] = [];
  if (job.summary && job.summary.trim()) {
    parts.push('SUMMARY');
    parts.push(job.summary.trim());
    parts.push('');
    parts.push('---');
    parts.push('');
    parts.push('TRANSCRIPT');
    parts.push('');
  }
  parts.push(job.text);
  const body = parts.join('\n');

  const filename = basenameNoExt(key) + '.txt';
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      'Cache-Control': 'private, no-store',
    },
  });
}
