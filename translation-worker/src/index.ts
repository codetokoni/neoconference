import "dotenv/config";
import { createClient, LiveTranscriptionEvents, LiveClient } from "@deepgram/sdk";
import { spawnAudio, type FfmpegAudio } from "./ffmpeg.js";
import { translate } from "./deepl.js";
import {
  broadcast,
  onFirstSubscriberForRoom,
  onLastSubscriberForRoom,
  startSseServer,
  type Line,
} from "./sse.js";

/**
 * NeoConference translation worker.
 *
 * A single process serves many rooms. Each room's pipeline (ffmpeg
 * pulling HLS → PCM → Deepgram Live → DeepL → SSE broadcast) is spun
 * up lazily the first time any SSE subscriber asks for that room's
 * translations, and torn down after an idle grace period once the
 * last subscriber leaves. That way rooms nobody is listening to don't
 * burn Deepgram or DeepL credits, and adding a new room to the app
 * needs no worker-side config — only that a real programme feed
 * exists at AMS_HTTP/streams/<room>-video.m3u8.
 *
 * Room lifecycle:
 *   • First subscriber for room R → startPipeline(R)
 *   • Every subsequent subscriber → no-op (pipeline already running,
 *     any pending teardown for R is cancelled)
 *   • Last subscriber leaves → schedule stopPipeline(R) after
 *     IDLE_GRACE_MS
 *   • New subscriber arrives during the grace window → cancel the
 *     pending stop, keep going
 */

const AMS_HTTP = required("AMS_HTTP"); // e.g. "https://ingest.streamlab.cloud/LiveApp"
const DEEPGRAM_KEY = required("DEEPGRAM_API_KEY");
const DEEPL_KEY = required("DEEPL_API_KEY");
const SSE_PORT = Number(process.env.SSE_PORT ?? "8080");
const TARGET_LANGS = (process.env.TARGET_LANGS ?? "fr,es,pt,ar")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const SOURCE_LANG = (process.env.SOURCE_LANG ?? "en").toLowerCase();
// How long to keep a room's pipeline warm after its last subscriber
// disconnects. Long enough to survive brief reloads/tab switches
// without paying reconnection latency; short enough that a truly
// abandoned room stops billing Deepgram/DeepL within a minute.
const IDLE_GRACE_MS = Number(process.env.IDLE_GRACE_MS ?? "60000");

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

interface Pipeline {
  audio: FfmpegAudio;
  live: LiveClient | null;
  seq: number;
  running: boolean;
  teardownTimer: ReturnType<typeof setTimeout> | null;
}

const pipelines = new Map<string, Pipeline>();

function hlsUrlForRoom(room: string): string {
  return `${AMS_HTTP.replace(/\/$/, "")}/streams/${room}-video.m3u8`;
}

async function translateAndBroadcast(
  room: string,
  pipeline: Pipeline,
  text: string,
  final: boolean,
): Promise<void> {
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
        pipeline.seq += 1;
        const line: Line = {
          lang,
          text: translated,
          seq: pipeline.seq,
          ts: Date.now(),
          original: cleaned,
          final,
        };
        broadcast(room, line);
        if (final) console.log(`[out][${room}][${lang}] ${translated}`);
      } catch (e) {
        console.error(`[deepl][${room}][${lang}]`, (e as Error).message);
      }
    }),
  );
}

function connectDeepgram(room: string, pipeline: Pipeline): LiveClient {
  const dg = createClient(DEEPGRAM_KEY);
  // interim_results deliberately OFF. Deepgram fires 5-15 interim
  // updates per second while someone is speaking; translating each of
  // them fanned out to 4 target langs was ~40-60 DeepL calls/second,
  // which blew through the Free-tier rate limit within seconds and
  // 429'd every subsequent request for the day. Finals-only is a
  // ~20× reduction in call volume, and for a broadcast audience
  // reading captions the sentence-stable output is actually easier
  // to follow than a caption that mutates as each word arrives.
  const conn = dg.listen.live({
    model: "nova-2",
    language: SOURCE_LANG,
    smart_format: true,
    interim_results: false,
    utterance_end_ms: 1000,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
  });

  conn.on(LiveTranscriptionEvents.Open, () => {
    console.log(`[deepgram][${room}] open`);
  });
  conn.on(LiveTranscriptionEvents.Close, (evt: { code?: number; reason?: string }) => {
    console.log(`[deepgram][${room}] close code=${evt?.code} reason=${evt?.reason}`);
  });
  conn.on(LiveTranscriptionEvents.Error, (err: unknown) => {
    console.error(`[deepgram][${room}] error`, err);
  });
  conn.on(LiveTranscriptionEvents.Transcript, (evt: {
    channel: { alternatives: { transcript: string }[] };
    is_final: boolean;
  }) => {
    // Belt-and-braces alongside interim_results:false — if Deepgram
    // ever sends a non-final anyway (SDK bug, config drift), we still
    // don't burn a DeepL call on it.
    if (!evt.is_final) return;
    const text = evt.channel.alternatives[0]?.transcript ?? "";
    if (!text) return;
    void translateAndBroadcast(room, pipeline, text, true);
  });

  return conn;
}

function startPipeline(room: string): void {
  const existing = pipelines.get(room);
  if (existing) {
    if (existing.teardownTimer) {
      clearTimeout(existing.teardownTimer);
      existing.teardownTimer = null;
      console.log(`[worker][${room}] teardown cancelled — new subscriber`);
    }
    return;
  }

  const url = hlsUrlForRoom(room);
  console.log(`[worker][${room}] starting pipeline source=${url}`);
  const audio = spawnAudio(url);
  const pipeline: Pipeline = {
    audio,
    live: null,
    seq: 0,
    running: true,
    teardownTimer: null,
  };
  pipeline.live = connectDeepgram(room, pipeline);
  pipelines.set(room, pipeline);

  audio.proc.stdout.on("data", (chunk: Buffer) => {
    try {
      // The SDK's send() is typed browser-first (Blob | ArrayBuffer).
      // Hand it a standalone ArrayBuffer rather than a Node Buffer view.
      pipeline.live?.send(new Uint8Array(chunk).buffer);
    } catch {
      /* Deepgram probably closed; the exit handler restarts */
    }
  });

  audio.onExit(() => {
    try {
      pipeline.live?.finish();
    } catch {
      /* ignore */
    }
    pipeline.live = null;
    // Backoff on restart so a genuinely-down source doesn't hammer
    // AMS or Deepgram with reconnects. Only restart if this pipeline
    // is still supposed to be running (i.e. hasn't been torn down by
    // the idle-grace timer while ffmpeg was flapping).
    setTimeout(() => {
      if (!pipeline.running || pipelines.get(room) !== pipeline) return;
      console.log(`[worker][${room}] ffmpeg exited, restarting`);
      pipelines.delete(room);
      startPipeline(room);
    }, 3000);
  });
}

function stopPipeline(room: string): void {
  const p = pipelines.get(room);
  if (!p) return;
  p.running = false;
  if (p.teardownTimer) {
    clearTimeout(p.teardownTimer);
    p.teardownTimer = null;
  }
  try {
    p.live?.finish();
  } catch {
    /* ignore */
  }
  p.live = null;
  try {
    p.audio.proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  pipelines.delete(room);
  console.log(`[worker][${room}] stopped`);
}

startSseServer(SSE_PORT);
console.log(
  `[worker] multi-room, langs=${TARGET_LANGS.join(",")} source=${SOURCE_LANG} idleGrace=${IDLE_GRACE_MS}ms`,
);

onFirstSubscriberForRoom((room) => {
  startPipeline(room);
});

onLastSubscriberForRoom((room) => {
  const p = pipelines.get(room);
  if (!p) return;
  if (p.teardownTimer) return;
  console.log(`[worker][${room}] idle, teardown in ${IDLE_GRACE_MS}ms`);
  p.teardownTimer = setTimeout(() => stopPipeline(room), IDLE_GRACE_MS);
});

function shutdown(signal: string) {
  console.log(`[worker] ${signal} — shutting down ${pipelines.size} pipeline(s)`);
  for (const room of Array.from(pipelines.keys())) stopPipeline(room);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
