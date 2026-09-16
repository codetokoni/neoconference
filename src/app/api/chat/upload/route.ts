// src/app/api/chat/upload/route.ts
//
// Chat attachment upload. Accepts a multipart form with one file
// field, PUTs it into R2 under a chat/ prefix, returns a signed GET
// URL (7-day expiry) plus metadata the sender puts into the
// broadcasted ChatMessage.
//
// Auth: signed-in Clerk users only. Prevents a public open-upload
// endpoint that would double as free file hosting.
//
// Size cap: 10 MB per attachment. The body is fully buffered in memory
// (Vercel default request body limit is 4.5MB unless raised; this
// route sets `maxDuration` + reads the body itself so it works up to
// 10 MB, but larger uploads should switch to signed-PUT-URL flow).
//
// MIME allow-list: broadly permissive (images, PDFs, common Office
// documents, plain text, common archives) — enough for a chat that
// operators use for sending programme sheets, images, screenshots.

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { randomUUID } from 'node:crypto';
import { isR2Configured, putObject, signGetUrl } from '@/lib/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Bumped from Vercel's 4s default so a slow uplink still lands a 10MB
// image inside the window. The endpoint is small even at max size.
export const maxDuration = 30;

const MAX_BYTES = 10 * 1024 * 1024;

// Broad allow-list: image formats, PDFs, common documents, plain text,
// common archives. Anything not on this list is refused up-front so a
// user can't stash executables in R2 via chat.
const ALLOWED = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/heic',
  'image/heif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/json',
  'application/zip',
]);

const IMAGE_MIMES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/heic',
  'image/heif',
]);

/** Restrict to path-safe chars; keep original extension for the card. */
function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() || 'file';
  return base
    .replace(/[^\w. \-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100) || 'file';
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isR2Configured()) {
    return NextResponse.json({ error: 'storage_not_configured' }, { status: 503 });
  }

  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('multipart/form-data')) {
    return NextResponse.json({ error: 'expected_multipart' }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json({ error: 'bad_form', detail: (e as Error).message }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file_field_missing' }, { status: 400 });
  }
  if (file.size <= 0) {
    return NextResponse.json({ error: 'empty_file' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: 'too_large', limit: MAX_BYTES, size: file.size },
      { status: 413 },
    );
  }
  const mime = (file.type || 'application/octet-stream').toLowerCase();
  if (!ALLOWED.has(mime)) {
    return NextResponse.json(
      { error: 'unsupported_type', mime },
      { status: 415 },
    );
  }

  const name = safeFilename(file.name || 'file');
  // Namespace by uploader so an admin browsing R2 later can tell who
  // put a file there without cross-referencing an external log.
  const key = `chat/${userId}/${randomUUID()}-${name}`;

  const buf = Buffer.from(await file.arrayBuffer());
  try {
    await putObject(key, buf, mime, {
      // Signed URLs already gate lifetime; a modest immutable cache
      // ttl saves the client from re-fetching the same image every
      // time it comes into view in the scroll buffer.
      cacheControl: 'private, max-age=86400',
    });
  } catch (e) {
    console.error('[chat/upload] R2 put failed', e);
    return NextResponse.json(
      { error: 'upload_failed', detail: (e as Error).message.slice(0, 200) },
      { status: 502 },
    );
  }

  // 7-day GET signature — enough for the meeting itself plus a
  // reasonable read-after window; chat history is ephemeral (LiveKit
  // data channel) so indefinite storage would be paying for URLs no
  // one can reach.
  const url = await signGetUrl(key, 60 * 60 * 24 * 7);
  const kind: 'image' | 'file' = IMAGE_MIMES.has(mime) ? 'image' : 'file';

  return NextResponse.json({
    ok: true,
    attachment: {
      url,
      name,
      mimeType: mime,
      size: file.size,
      kind,
    },
  });
}
