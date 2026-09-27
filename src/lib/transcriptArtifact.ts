// src/lib/transcriptArtifact.ts
//
// When a transcription tied to a meeting finishes, record it on the event
// so /e/<slug>/replay can show it without a separate lookup. Called by
// POST /api/transcribe for a job that finished inline and by the Deepgram
// callback for one that finished later.

import { eventStore } from '@/lib/eventStore';
import type { TranscribeJob } from '@/lib/transcribe';
import type { NeoEvent, RecordingArtifact } from '@/types/event';

/** Best-effort: the transcript itself is already saved on the job. */
export async function attachTranscriptToEvent(job: TranscribeJob): Promise<void> {
  if (job.status !== 'done' || !job.text || !job.eventSlug) return;
  try {
    const ev = await eventStore.bySlug(job.eventSlug);
    if (!ev) return;
    const artifact: RecordingArtifact = {
      key: 'transcript:' + job.id,
      kind: 'transcript',
      label: job.text,
      createdAt: job.updatedAt,
      size: job.text.length,
    };
    await eventStore.update(ev.id, (prev: NeoEvent) => ({
      ...prev,
      // A retried callback must not add the same transcript twice.
      recordings: [
        ...(prev.recordings || []).filter((r) => r.key !== artifact.key),
        artifact,
      ],
      updatedAt: new Date().toISOString(),
    }));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[transcribe] failed to attach transcript to event', e);
  }
}
