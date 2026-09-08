import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Pull audio from an HLS/RTMP/WebRTC-viewable URL and stream 16 kHz mono
 * PCM on stdout for the STT client to slurp.
 *
 * Uses ffmpeg. That's the trade — the worker requires ffmpeg on the
 * host image (the Dockerfile installs it), but we avoid pulling a full
 * WebRTC-in-Node stack. HLS latency (~5 s) is fine for translated
 * captions; the audience is reading, not conducting.
 *
 * The ffmpeg process is respawned on exit so a transient HLS 404 (e.g.
 * the programme feed briefly going off air between segments) doesn't
 * kill the worker.
 */
export interface FfmpegAudio {
  proc: ChildProcessWithoutNullStreams;
  onExit: (fn: () => void) => void;
}

export function spawnAudio(sourceUrl: string): FfmpegAudio {
  const args = [
    "-loglevel",
    "warning",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-i",
    sourceUrl,
    "-vn",
    "-acodec",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-f",
    "s16le",
    "pipe:1",
  ];

  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  proc.stderr.on("data", (d) => {
    const line = d.toString().trim();
    if (line) console.log("[ffmpeg] " + line);
  });

  const exitHandlers: Array<() => void> = [];
  proc.on("exit", (code, signal) => {
    console.log(`[ffmpeg] exited code=${code} signal=${signal}`);
    for (const fn of exitHandlers) fn();
  });

  return {
    proc,
    onExit(fn) {
      exitHandlers.push(fn);
    },
  };
}
