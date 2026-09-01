// captions-worker/src/agent.ts
//
// LiveKit Agent worker for NeoConference captions.
//
// Registers as the `neo-captions` agent so the existing dispatch route
// (src/app/api/livekit/captions/dispatch/route.ts) reaches this worker
// unchanged. When LiveKit dispatches a job into a room the agent:
//
//   1. Joins the room as an agent-kind participant.
//   2. Waits for the host to publish `{ type: 'captions', enabled: true }`
//      on the data channel. That gate matches the CaptionsToggle
//      component's protocol — participants see the CC pill light up
//      based on this same broadcast.
//   3. On enable: opens a Deepgram Live stream per subscribed audio
//      track, feeds the audio in, and publishes each Deepgram
//      transcript back into the room as a LiveKit TranscriptionSegment
//      (which the LiveCaptions and LiveTranslation clients already
//      consume).
//   4. On disable: closes all Deepgram streams and waits for the next
//      enable.
//   5. Periodically rebroadcasts the current enabled state so
//      late-joining clients pick it up (mirrors what the client-side
//      CaptionsToggle already expects from its comment).
//
// Env:
//   LIVEKIT_URL          wss://…      — LiveKit project WS URL
//   LIVEKIT_API_KEY      APIxxxx      — LiveKit project API key
//   LIVEKIT_API_SECRET   …            — LiveKit project API secret
//   DEEPGRAM_API_KEY     …            — Deepgram API key
//   AGENT_NAME           neo-captions — override the registration name
//                                       if you're testing next to a live
//                                       worker; default matches the
//                                       NeoConference dispatch route
//   DEEPGRAM_MODEL       nova-2       — Deepgram model to use
//   DEEPGRAM_LANGUAGE    multi        — "multi" for auto-detect, or a
//                                       BCP-47 short tag ("en", "es", …)

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  AutoSubscribe,
  type JobContext,
  JobType,
  WorkerOptions,
  cli,
  defineAgent,
  stt,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import {
  RoomEvent,
  TrackKind,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type RemoteAudioTrack,
  AudioStream,
} from '@livekit/rtc-node';

const AGENT_NAME = process.env.AGENT_NAME || 'neo-captions';
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-2';
const DEEPGRAM_LANGUAGE = process.env.DEEPGRAM_LANGUAGE || 'multi';
const DATA_MSG_TYPE = 'captions';
const REBROADCAST_INTERVAL_MS = 15_000;

interface TrackTranscription {
  close(): void;
  participantIdentity: string;
  trackSid: string;
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    console.log(
      `[neo-captions] job received: room=${ctx.job.room?.name ?? '?'}, ` +
        `dispatch=${ctx.job.dispatchId}`,
    );

    // Subscribe to all published tracks by default so we can start
    // transcribing whichever track the enable signal arrives first for.
    // The audio stream is only actually opened once captions are enabled.
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);

    console.log(`[neo-captions] joined room ${ctx.room.name}`);

    let enabled = false;
    const perTrack = new Map<string, TrackTranscription>();

    // Shared Deepgram STT instance — plugin manages one connection per
    // stream() invocation, so multiple concurrent tracks each get their
    // own websocket to Deepgram.
    const sttEngine = new deepgram.STT({
      model: DEEPGRAM_MODEL,
      language: DEEPGRAM_LANGUAGE,
      smartFormat: true,
      interimResults: true,
    });

    const openForTrack = async (
      participant: RemoteParticipant,
      publication: RemoteTrackPublication,
      track: RemoteAudioTrack,
    ) => {
      if (!enabled) return;
      if (publication.kind !== TrackKind.KIND_AUDIO) return;
      const key = `${participant.identity}:${publication.sid}`;
      if (perTrack.has(key)) return;

      console.log(`[neo-captions] opening STT for ${key}`);

      const audioStream = new AudioStream(track);
      const sttStream = sttEngine.stream();

      // Pump: PCM frames from LiveKit → Deepgram plugin buffer.
      const pumpAudio = async () => {
        try {
          for await (const frame of audioStream) {
            sttStream.pushFrame(frame);
          }
        } catch (e) {
          console.warn(`[neo-captions] audio pump ended for ${key}:`, e);
        } finally {
          sttStream.endInput();
        }
      };
      pumpAudio();

      // Pull: transcripts out of Deepgram plugin → LiveKit transcription
      // segments back into the room. `publishTranscription` is the
      // official way to surface these; LiveKit fans them out to every
      // subscriber via TranscriptionReceived, which LiveCaptions and
      // LiveTranslation already handle.
      const pumpTranscripts = async () => {
        try {
          for await (const ev of sttStream) {
            if (ev.type !== stt.SpeechEventType.INTERIM_TRANSCRIPT &&
                ev.type !== stt.SpeechEventType.FINAL_TRANSCRIPT) {
              continue;
            }
            const alt = ev.alternatives?.[0];
            if (!alt) continue;
            const text = (alt.text || '').trim();
            if (!text) continue;

            const isFinal = ev.type === stt.SpeechEventType.FINAL_TRANSCRIPT;
            const now = Date.now();
            const segmentId = isFinal
              ? randomUUID()
              : `interim-${key}-${Math.floor(now / 100)}`;

            try {
              await ctx.room.localParticipant?.publishTranscription({
                participantIdentity: participant.identity,
                trackSid: publication.sid,
                segments: [
                  {
                    id: segmentId,
                    text,
                    startTime: BigInt(0),
                    endTime: BigInt(0),
                    language: alt.language || DEEPGRAM_LANGUAGE,
                    final: isFinal,
                  },
                ],
              });
            } catch (e) {
              console.warn('[neo-captions] publishTranscription failed', e);
            }
          }
        } catch (e) {
          console.warn(`[neo-captions] transcript stream ended for ${key}:`, e);
        }
      };
      pumpTranscripts();

      perTrack.set(key, {
        close: () => {
          try {
            audioStream.close();
          } catch {}
          try {
            sttStream.endInput();
          } catch {}
        },
        participantIdentity: participant.identity,
        trackSid: publication.sid,
      });
    };

    const closeAll = () => {
      for (const s of perTrack.values()) s.close();
      perTrack.clear();
    };

    const startAllCurrent = () => {
      for (const p of ctx.room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub.kind !== TrackKind.KIND_AUDIO) continue;
          const track = pub.track as RemoteAudioTrack | undefined;
          if (!track) continue;
          openForTrack(p, pub, track);
        }
      }
    };

    // React to enable / disable broadcasts.
    ctx.room.on(RoomEvent.DataReceived, (payload) => {
      let msg: { type?: string; enabled?: boolean };
      try {
        msg = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      if (!msg || msg.type !== DATA_MSG_TYPE) return;
      if (typeof msg.enabled !== 'boolean') return;
      if (msg.enabled === enabled) return;

      enabled = msg.enabled;
      console.log(`[neo-captions] enabled=${enabled}`);
      if (enabled) {
        startAllCurrent();
      } else {
        closeAll();
      }
    });

    // React to tracks arriving after captions were already enabled.
    ctx.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (publication.kind !== TrackKind.KIND_AUDIO) return;
      openForTrack(
        participant as RemoteParticipant,
        publication as RemoteTrackPublication,
        track as RemoteAudioTrack,
      );
    });
    ctx.room.on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
      const key = `${participant.identity}:${publication.sid}`;
      const existing = perTrack.get(key);
      if (existing) {
        existing.close();
        perTrack.delete(key);
      }
    });

    // Periodic rebroadcast of the current enabled state so late joiners
    // (including the CaptionsToggle pill on other clients) catch up.
    const rebroadcastTimer = setInterval(() => {
      const lp = ctx.room.localParticipant;
      if (!lp) return;
      try {
        const payload = new TextEncoder().encode(
          JSON.stringify({ type: DATA_MSG_TYPE, enabled }),
        );
        // Reliable so the message survives packet loss on a poor
        // client connection.
        lp.publishData(payload, { reliable: true });
      } catch (e) {
        // Best-effort; the worker keeps going.
        console.warn('[neo-captions] rebroadcast failed', e);
      }
    }, REBROADCAST_INTERVAL_MS);

    // Clean up on room disconnect.
    ctx.room.on(RoomEvent.Disconnected, () => {
      console.log('[neo-captions] room disconnected — closing streams');
      clearInterval(rebroadcastTimer);
      closeAll();
    });
  },
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    workerType: JobType.JT_ROOM,
    agentName: AGENT_NAME,
  }),
);
