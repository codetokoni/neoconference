// agents/captions-worker/src/index.ts
//
// NeoConference live-captions worker.
//
// Runs as a standalone Node service on Railway. Joins a LiveKit room as a
// hidden participant (publishes no media), subscribes to every other
// participant's microphone track, streams the audio frames to Deepgram's
// streaming STT API, and republishes the resulting transcripts back into
// the room via LiveKit's built-in Transcription API so the existing
// LiveCaptions overlay receives RoomEvent.TranscriptionReceived events for
// all participants.
//
// Activation model: explicit dispatch. A host clicks the CC toolbar button
// in the web app, which calls our Next.js /api/livekit/captions/dispatch
// route; that route uses LiveKit's AgentDispatchClient to dispatch this
// worker into the room. The worker stays alive for the lifetime of the
// room and tears itself down when the room ends.
//
// Toggle off: the host clicks CC again. The web app publishes a
// { type: 'captions', enabled: false } reliable data message to the room.
// We listen for it and stop forwarding audio to Deepgram (but keep the
// connection warm) until another { enabled: true } message arrives.

import { config as loadEnv } from 'dotenv';
import {
  defineAgent,
  cli,
  WorkerOptions,
  type JobContext,
  AutoSubscribe,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import {
  RoomEvent,
  TrackKind,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  AudioStream,
} from '@livekit/rtc-node';

loadEnv();

const DEEPGRAM_API_KEY =
  process.env.DEEPGRAM_API_KEY_STREAMING || process.env.DEEPGRAM_API_KEY || '';

if (!DEEPGRAM_API_KEY) {
  // We still start up so the agent is healthy in the dispatcher's eyes, but
  // log loudly so the operator notices the misconfiguration.
  console.error(
    '[captions-worker] FATAL: no DEEPGRAM_API_KEY_STREAMING or DEEPGRAM_API_KEY in env',
  );
}

// Per-room enable flag. Defaults to false so the worker is always silent
// until the host explicitly toggles CC on.
type RoomState = { enabled: boolean };

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const room = ctx.room;
    const state: RoomState = { enabled: false };

    console.log(
      `[captions-worker] entering room=${room.name} sid=${room.sid ?? 'pending'}`,
    );

    // Connect to the room. We don't auto-subscribe so we can be selective
    // (audio only, skip our own track if any).
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

    // ---- data-channel control plane -----------------------------------
    // Host toggles captions on/off by publishing a reliable data message:
    //   { type: 'captions', enabled: true | false }
    // Only the local-participant identity flagged as host or cohost in the
    // room metadata is honored; everyone else is ignored (defense in depth
    // - the web client also gates the button on roomRole).
    room.on(RoomEvent.DataReceived, (payload, participant) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as {
          type?: string;
          enabled?: boolean;
        };
        if (msg?.type !== 'captions') return;
        const md = participant?.metadata
          ? JSON.parse(participant.metadata)
          : null;
        const role = md?.role as string | undefined;
        if (role !== 'host' && role !== 'cohost') {
          console.warn(
            `[captions-worker] ignoring captions toggle from non-host ${participant?.identity} (role=${role})`,
          );
          return;
        }
        state.enabled = !!msg.enabled;
        console.log(
          `[captions-worker] captions ${state.enabled ? 'ENABLED' : 'DISABLED'} by ${participant?.identity}`,
        );
      } catch {
        // ignore malformed data packets
      }
    });

    // ---- per-track Deepgram pipeline ----------------------------------
    const stt = new deepgram.STT({
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
      console.log(
        `[captions-worker] subscribing audio from ${participant.identity}`,
      );

      const audio = new AudioStream(track);
      const session = stt.stream();

      (async () => {
        try {
          for await (const frame of audio) {
            if (!state.enabled) continue;
            session.pushFrame(frame);
          }
        } catch (e) {
          console.error(
            `[captions-worker] audio pump error for ${participant.identity}:`,
            e,
          );
        } finally {
          session.endInput();
        }
      })();

      (async () => {
        try {
          for await (const ev of session) {
            if (!ev?.alternatives?.length) continue;
            const alt = ev.alternatives[0];
            if (!alt?.text) continue;
            await room.localParticipant?.publishTranscription({
              participantIdentity: participant.identity,
              trackId: track.sid ?? '',
              segments: [
                {
                  id: `${participant.identity}-${Date.now()}`,
                  text: alt.text,
                  startTime: BigInt(ev.startTime ?? 0),
                  endTime: BigInt(ev.endTime ?? 0),
                  language: alt.language ?? 'en',
                  final: !!ev.isFinal,
                },
              ],
            });
          }
        } catch (e) {
          console.error(
            `[captions-worker] transcript pump error for ${participant.identity}:`,
            e,
          );
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
  },
});

cli.runApp(new WorkerOptions({ agent: __filename }));
