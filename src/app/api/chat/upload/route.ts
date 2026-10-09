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
// Size cap and allowed types: set in the admin area (Content > Limits,
// src/lib/content/limits.ts) — 10 MB of images, PDFs, Office documents,
// text and ZIP until changed. The body is fully buffered in memory, so
// much larger uploads should switch to a signed-PUT-URL flow.

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { randomUUID } from 'node:crypto';
import { isR2Configured, putObject, signGetUrl } from '@/lib/r2';
import { CHAT_IMAGE_MIMES, safeFilename } from '@/lib/chatUploadRules';
import { refuseUpload, uploadRule } from '@/lib/content/limits';
import { storedMime } from '@/lib/content/model';
import { indexUpload, indexUploadFailed } from '@/lib/content/files';
import { activity } from '@/lib/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Bumped from Vercel's 4s default so a slow uplink still lands a 10MB
// image inside the window. The endpoint is small even at max size.
export const maxDuration = 30;

const IMAGE_MIMES = CHAT_IMAGE_MIMES;

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
  // Size and type limits are set in the admin area (Content > Limits).
  const refused = await refuseUpload('chat', file, userId);
  if (refused) return refused;
  const mime = storedMime(await uploadRule('chat'), file);

  const name = safeFilename(file.name || 'file');
  // Namespace by uploader so an admin browsing R2 later can tell who
  // put a file there without cross-referencing an external log.
  const key = `chat/${userId}/${randomUUID()}-${name}`;

  const buf = Buffer.from(await file.arrayBuffer());
  const indexed = { key, type: 'chat_upload' as const, ownerId: userId, name, size: file.size, contentType: mime, body: buf };
  try {
    await putObject(key, buf, mime, {
      // Signed URLs already gate lifetime; a modest immutable cache
      // ttl saves the client from re-fetching the same image every
      // time it comes into view in the scroll buffer.
      cacheControl: 'private, max-age=86400',
    });
  } catch (e) {
    console.error('[chat/upload] R2 put failed', e);
    await indexUploadFailed({ ...indexed, detail: (e as Error).message });
    return NextResponse.json(
      { error: 'upload_failed', detail: (e as Error).message.slice(0, 200) },
      { status: 502 },
    );
  }

  // The admin file index (Content): owner, size, type, checksum.
  await indexUpload(indexed);

  // 7-day GET signature — enough for the meeting itself plus a
  // reasonable read-after window; chat history is ephemeral (LiveKit
  // data channel) so indefinite storage would be paying for URLs no
  // one can reach.
  const url = await signGetUrl(key, 60 * 60 * 24 * 7);
  await activity.record('upload', { userId, account: userId, props: { where: 'meeting_chat', bytes: file.size, mime } });
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
