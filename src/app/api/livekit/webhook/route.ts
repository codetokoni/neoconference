// src/app/api/livekit/webhook/route.ts
//
// LiveKit webhook handler. Configure this URL in your LiveKit Cloud project
// settings (Webhooks tab) — it must point to:
//   https://www.neoconference.app/api/livekit/webhook
//
// We listen for 'egress_ended' and auto-submit a transcription job so the
// transcript + summary are ready by the time the host opens /dashboard/recordings.
//
// Signature verification is handled by livekit-server-sdk's WebhookReceiver,
// which validates the Authorization header against the project's API secret.

import { NextResponse } from 'next/server';
import { WebhookReceiver } from 'livekit-server-sdk';
import { submitTranscribeJob, isTranscribeConfigured } from '@/lib/transcribe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error('Missing env: ' + name);
  return v;
}

export async function POST(req: Request) {
  try {
    const apiKey = requiredEnv('LIVEKIT_API_KEY');
    const apiSecret = requiredEnv('LIVEKIT_API_SECRET');
    const receiver = new WebhookReceiver(apiKey, apiSecret);

    // LiveKit signs the raw request body. We must pass it as a string along
    // with the Authorization header (which contains the signature JWT).
    const body = await req.text();
    const authHeader = req.headers.get('Authorization') || '';

    type LKEgressInfo = {
      egressId?: string;
      roomId?: string;
      roomName?: string;
      status?: number | string;
      file?: { filename?: string; location?: string };
      fileResults?: Array<{ filename?: string; location?: string }>;
    };
    type LKWebhookEvent = {
      event?: string;
      egressInfo?: LKEgressInfo;
      room?: { name?: string };
    };

    const event = (await receiver.receive(body, authHeader)) as unknown as LKWebhookEvent;

    // We only auto-transcribe when a recording egress finished writing.
    if (event?.event !== 'egress_ended') {
      return NextResponse.json({ ok: true, ignored: event?.event || 'unknown' });
    }

    // Extract the R2 key that egress wrote to. LiveKit gives us either a
    // single file or an array depending on egress type.
    const egressInfo = event.egressInfo;
    const fileFromInfo = egressInfo?.file?.filename;
    const fileFromResults = egressInfo?.fileResults?.[0]?.filename;
    const filename = fileFromInfo || fileFromResults || '';
    if (!filename) {
      return NextResponse.json({ ok: true, skipped: 'no file path on egress' });
    }

    // egress writes 'recordings/user_xxx/event-slug/timestamp.mp4'. We pass
    // the full key as the recordingKey. Try to extract the event slug from
    // the path so we can later attach the transcript to the event.
    const parts = filename.split('/');
    // parts: ['recordings', 'user_xxx', 'event-slug', 'timestamp.mp4']
    const eventSlug = parts.length >= 4 ? parts[2] : undefined;

    if (!isTranscribeConfigured()) {
      // Provider is in stub mode — webhook is still 200, we just don't run.
      return NextResponse.json({
        ok: true,
        skipped: 'transcribe provider not configured',
        filename,
      });
    }

    // Kick the transcribe job. submitTranscribeJob blocks until Deepgram
    // returns (Nova-3 is fast: <30 s for a typical meeting). LiveKit's
    // webhook delivery timeout is 30 s; for longer recordings we'd switch
    // to a fire-and-forget pattern with a status row in KV. For now, await.
    const job = await submitTranscribeJob({
      recordingKey: filename,
      eventSlug,
    });

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      status: job.status,
      filename,
      eventSlug,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Always return 200 on signature mismatch / bad payload so LiveKit doesn't
    // retry endlessly; surface the error in the response body for debugging.
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}
