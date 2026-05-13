// @ts-nocheck -- TODO: re-enable after verifying SpeechStream runtime API matches type defs in @livekit/agents 1.4.1
// // agents/captions-worker/src/agent.ts
//
// NeoConference live-captions worker entry function.
// Joins a LiveKit room, subscribes to other participants' audio, streams to
// Deepgram, republishes transcripts via LiveKit Transcription API.

import { AutoSubscribe, type JobContext, stt } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import {
  AudioStream,
  RoomEvent,
  TrackKind,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from '@livekit/rtc-node';

const DEEPGRAM_API_KEY =
  process.env.DEEPGRAM_API_KEY_STREAMING || process.env.DEEPGRAM_API_KEY || '';

if (!DEEPGRAM_API_KEY) {
  console.error('[captions-worker] FATAL: no DEEPGRAM_API_KEY_STREAMING or DEEPGRAM_API_KEY in env');
}

type RoomState = { enabled: boolean };

export default async (ctx: JobContext): Promise<void> => {
  const room = ctx.room;
  const state: RoomState = { enabled: false };

  console.log(`[captions-worker] entering room=${room.name}`);

  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

  room.on(RoomEvent.DataReceived, (payload, participant) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(payload)) as { type?: string; enabled?: boolean };
      if (msg?.type !== 'captions') return;
      const md = participant?.metadata ? JSON.parse(participant.metadata) : null;
      const role = md?.role as string | undefined;
      if (role !== 'host' && role !== 'cohost') {
        console.warn(`[captions-worker] ignoring captions toggle from non-host ${participant?.identity} (role=${role})`);
        return;
      }
      state.enabled = !!msg.enabled;
      console.log(`[captions-worker] captions ${state.enabled ? 'ENABLED' : 'DISABLED'} by ${participant?.identity}`);
    } catch {
      // ignore malformed data packets
    }
  });

  const sttClient = new deepgram.STT({
    apiKey: DEEPGRAM_API_KEY,
    model: 'nova-3',
    interimResults: true,
    smartFormat: true,
    punctuate: true,
    language: 'multi',
  });

  const startPipe = async (
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    console.log(`[captions-worker] subscribing audio from ${participant.identity}`);

    const audio = new AudioStream(track);
    const session = sttClient.stream();

    (async () => {
      try {
        for await (const frame of audio) {
          if (!state.enabled) continue;
          session.pushFrame(frame);
        }
      } catch (e) {
        console.error(`[captions-worker] audio pump error for ${participant.identity}:`, e);
      } finally {
        try { session.endInput(); } catch { /* already closed */ }
      }
    })();

    (async () => {
      try {
        for await (const ev of session) {
          if (ev.type !== stt.SpeechEventType.INTERIM_TRANSCRIPT && ev.type !== stt.SpeechEventType.FINAL_TRANSCRIPT) continue;
          const alt = ev.alternatives?.[0];
          if (!alt?.text) continue;
          await room.localParticipant?.publishTranscription({
            participantIdentity: participant.identity,
            trackSid: track.sid ?? '',
            segments: [{
              id: `${participant.identity}-${Date.now()}`,
              text: alt.text,
              startTime: BigInt(Math.round((alt.startTime ?? 0) * 1e9)),
              endTime: BigInt(Math.round((alt.endTime ?? 0) * 1e9)),
              language: alt.language ?? 'en',
              final: ev.type === stt.SpeechEventType.FINAL_TRANSCRIPT,
            }],
          });
        }
      } catch (e) {
        console.error(`[captions-worker] transcript pump error for ${participant.identity}:`, e);
      }
    })();
  };

  room.on(RoomEvent.TrackSubscribed, startPipe);

  await new Promise<void>((resolve) => {
    room.on(RoomEvent.Disconnected, () => {
      console.log('[captions-worker] room disconnected, shutting down');
      resolve();
    });
  });
};
