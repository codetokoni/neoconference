import "dotenv/config";
import { createClient, LiveTranscriptionEvents, LiveClient } from "@deepgram/sdk";
import { spawnAudio } from "./ffmpeg.js";
import { translate } from "./deepl.js";
import { broadcast, startSseServer, type Line } from "./sse.js";

/**
 * NeoConference translation worker.
 *
 * Pulls the programme audio for one room from AMS via HLS, runs it
 * through Deepgram Live for streaming STT, translates each final
 * transcript into every configured target language via DeepL, and
 * broadcasts the result over SSE so any /video/dashboard or /video/join
 * client can subscribe and speak the captions via browser TTS (Phase 1)
 * or, later, mix a TTS audio channel back into AMS (Phase 2).
 *
 * One worker instance covers one room's programme feed. To translate a
 * second event, run a second worker with a different ROOM env.
 */

const ROOM = required("ROOM"); // e.g. "neoconf"
const AMS_HTTP = required("AMS_HTTP"); // e.g. "https://ingest.streamlab.cloud/LiveApp"
const DEEPGRAM_KEY = required("DEEPGRAM_API_KEY");
const DEEPL_KEY = required("DEEPL_API_KEY");
const SSE_PORT = Number(process.env.SSE_PORT ?? "8080");
const TARGET_LANGS = (process.env.TARGET_LANGS ?? "fr,es,pt,ar")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const SOURCE_LANG = (process.env.SOURCE_LANG ?? "en").toLowerCase();

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

startSseServer(SSE_PORT);

console.log(
  `[worker] room=${ROOM} langs=${TARGET_LANGS.join(",")} source=${SOURCE_LANG}`,
);

const HLS_URL = `${AMS_HTTP.replace(/\/$/, "")}/streams/${ROOM}-video.m3u8`;
console.log(`[worker] source=${HLS_URL}`);

let seq = 0;
let live: LiveClient | null = null;

async function translateAndBroadcast(text: string, final: boolean) {
  const cleaned = text.trim();
  if (!cleaned) return;
  // Fan out to every target language in parallel. If any DeepL call
  // fails, log and drop — the others still land.
  await Promise.all(
    TARGET_LANGS.map(async (lang) => {
      try {
        const translated = await translate(
          DEEPL_KEY,
          cleaned,
          lang,
          SOURCE_LANG.toUpperCase(),
        );
        seq += 1;
        const line: Line = {
          lang,
          text: translated,
          seq,
          ts: Date.now(),
          original: cleaned,
          final,
        };
        broadcast(ROOM, line);
        if (final) console.log(`[out][${lang}] ${translated}`);
      } catch (e) {
        console.error(`[deepl][${lang}]`, (e as Error).message);
      }
    }),
  );
}

function connectDeepgram(): LiveClient {
  const dg = createClient(DEEPGRAM_KEY);
  const conn = dg.listen.live({
    model: "nova-2",
    language: SOURCE_LANG,
    smart_format: true,
    interim_results: true,
    utterance_end_ms: 1000,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
  });

  conn.on(LiveTranscriptionEvents.Open, () => {
    console.log("[deepgram] open");
  });
  conn.on(LiveTranscriptionEvents.Close, (evt: { code?: number; reason?: string }) => {
    console.log(`[deepgram] close code=${evt?.code} reason=${evt?.reason}`);
  });
  conn.on(LiveTranscriptionEvents.Error, (err: unknown) => {
    console.error("[deepgram] error", err);
  });
  conn.on(LiveTranscriptionEvents.Transcript, (evt: {
    channel: { alternatives: { transcript: string }[] };
    is_final: boolean;
  }) => {
    const text = evt.channel.alternatives[0]?.transcript ?? "";
    if (!text) return;
    // Broadcast interim results too — the audience sees the sentence
    // building. Only the final counts as a full utterance.
    void translateAndBroadcast(text, Boolean(evt.is_final));
  });

  return conn;
}

function pumpAudio() {
  const audio = spawnAudio(HLS_URL);
  live = connectDeepgram();

  audio.proc.stdout.on("data", (chunk: Buffer) => {
    try {
      // The SDK's send() is typed browser-first (Blob | ArrayBuffer).
      // Hand it a standalone ArrayBuffer rather than a Node Buffer view.
      live?.send(new Uint8Array(chunk).buffer);
    } catch {
      /* Deepgram probably closed; the exit handler restarts */
    }
  });

  audio.onExit(() => {
    try {
      live?.finish();
    } catch {
      /* ignore */
    }
    live = null;
    // Backoff on restart so a genuinely-down source doesn't hammer
    // AMS or Deepgram with reconnects.
    setTimeout(pumpAudio, 3000);
  });
}

pumpAudio();

process.on("SIGINT", () => {
  console.log("[worker] SIGINT — shutting down");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("[worker] SIGTERM — shutting down");
  process.exit(0);
});
