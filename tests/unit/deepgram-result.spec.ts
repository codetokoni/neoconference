import { test, expect } from "@playwright/test";
import {
  audioSidecarKeys,
  callbackSignatureOk,
  callbackUrl,
  jobFromDeepgram,
} from "../../src/lib/deepgramResult";
import type { TranscribeJob } from "../../src/lib/transcribe";

const job: TranscribeJob = {
  id: "job-1",
  recordingKey: "recordings/u/hsmanagers/2026-09-08-09-08-51.mp4",
  provider: "deepgram",
  status: "running",
  createdAt: "2026-09-27T12:00:00Z",
  updatedAt: "2026-09-27T12:00:00Z",
};
const at = "2026-09-27T12:03:00Z";

test.describe("a Deepgram result", () => {
  test("a transcript finishes the job with text, speakers and summary", () => {
    const r = jobFromDeepgram(
      job,
      {
        metadata: { request_id: "dg-1" },
        results: {
          channels: [{ alternatives: [{ transcript: "Welcome everyone." }] }],
          summary: { short: "A welcome." },
          utterances: [{ start: 1.2345, end: 2.5, speaker: 0, transcript: " Welcome everyone. " }],
        },
      },
      at
    );
    expect(r.status).toBe("done");
    expect(r.text).toBe("Welcome everyone.");
    expect(r.summary).toBe("A welcome.");
    expect(r.externalId).toBe("dg-1");
    expect(r.segments).toEqual([{ startMs: 1235, endMs: 2500, text: "Welcome everyone.", speaker: 0 }]);
    expect(r.updatedAt).toBe(at);
  });

  test("an error body fails the job with Deepgram's words", () => {
    const r = jobFromDeepgram(job, { err_code: "REMOTE_CONTENT_ERROR", err_msg: "Could not fetch" }, at);
    expect(r.status).toBe("error");
    expect(r.error).toBe("Deepgram: Could not fetch");
  });

  test("no words is an error, not an empty transcript", () => {
    const r = jobFromDeepgram(job, { results: { channels: [{ alternatives: [{ transcript: "" }] }] } }, at);
    expect(r.status).toBe("error");
    expect(r.error).toContain("found no words");
  });
});

/**
 * Why a transcript came back empty. It said "silent audio?" every time; a
 * real recording that said so held 12 seconds of speech at a normal level.
 */
test.describe("an empty transcript says what Deepgram heard", () => {
  const empty = (metadata: object, channel: object = {}) =>
    jobFromDeepgram(
      job,
      { metadata, results: { channels: [{ alternatives: [{ transcript: "" }], ...channel }] } },
      at
    ).error;

  test("how long the audio was, and the language it detected", () => {
    expect(empty({ duration: 15.2 }, { detected_language: "fr", language_confidence: 0.83 })).toBe(
      "Deepgram heard 15 s of audio (language detected: French, 83% sure) but found no words in it."
    );
  });

  test("no language it can name means no speech, not 'English, 0% sure'", () => {
    expect(empty({ duration: 61.3 }, { detected_language: "en", language_confidence: 0 })).toBe(
      "Deepgram heard 61 s of audio but no speech it could make out. Was the microphone on and near the speaker?"
    );
  });

  test("nothing at all is said as such", () => {
    expect(empty({ duration: 0.2 })).toContain("received no audio");
  });

  test("Deepgram's own warnings are passed on", () => {
    expect(
      empty({ duration: 15, warnings: [{ parameter: "summarize", type: "unsupported_language", message: "Summarization is only supported for English" }] })
    ).toContain("Deepgram said: Summarization is only supported for English");
  });

  test("without details it still does not guess 'silent'", () => {
    expect(empty({})).toBe("Deepgram heard the audio but found no words in it.");
  });
});

test.describe("the callback signature", () => {
  test("the URL it builds carries a signature that verifies", () => {
    const url = new URL(callbackUrl("https://www.neoconference.app/", "job-1", "secret"));
    expect(url.pathname).toBe("/api/transcribe/deepgram");
    expect(url.searchParams.get("job")).toBe("job-1");
    expect(callbackSignatureOk("job-1", url.searchParams.get("sig")!, "secret")).toBe(true);
  });

  test("another job's signature, a wrong secret, or none is refused", () => {
    const sig = new URL(callbackUrl("https://x", "job-1", "secret")).searchParams.get("sig")!;
    expect(callbackSignatureOk("job-2", sig, "secret")).toBe(false);
    expect(callbackSignatureOk("job-1", sig, "other")).toBe(false);
    expect(callbackSignatureOk("job-1", "", "secret")).toBe(false);
    expect(callbackSignatureOk("job-1", sig, "")).toBe(false);
  });
});

test.describe("which file Deepgram is sent", () => {
  test("a video's audio sidecar, newest naming first", () => {
    expect(audioSidecarKeys("recordings/u/s/t.mp4")).toEqual(["recordings/u/s/t.m4a.mp4", "recordings/u/s/t.m4a"]);
  });

  test("an audio file is sent as it is", () => {
    expect(audioSidecarKeys("recordings/u/s/t.m4a.mp4")).toEqual([]);
    expect(audioSidecarKeys("recordings/u/s/t.m4a")).toEqual([]);
  });
});
