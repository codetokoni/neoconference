import { test, expect } from "@playwright/test";
import {
  asReported,
  STALE_JOB_MS,
  TRANSCRIBE_DID_NOT_FINISH,
  TRANSCRIBE_NOT_SET_UP,
} from "../../src/lib/transcribeNotSetUp";

type Job = { id: string; recordingKey: string; provider: string; status: string; error?: string; updatedAt?: string };

const job = (provider: string, status: string, extra: { error?: string; updatedAt?: string } = {}): Job => ({
  id: "j1",
  recordingKey: "recordings/u/s/2026-09-08-09-08-51.mp4",
  provider,
  status,
  ...extra,
});

test.describe("a transcription job as it is reported", () => {
  test("a stub job still queued never ran, and says so", () => {
    const r = asReported(job("stub", "queued"));
    expect(r.status).toBe("error");
    expect(r.error).toBe(TRANSCRIBE_NOT_SET_UP);
  });

  test("a real provider's jobs are reported as stored", () => {
    for (const status of ["queued", "running", "done", "error"]) {
      expect(asReported(job("deepgram", status))).toEqual(job("deepgram", status));
    }
  });

  test("a stub job that ended some other way is left alone", () => {
    const failed = job("stub", "error", { error: "R2 not configured" });
    expect(asReported(failed)).toEqual(failed);
  });

  test("a real job still queued long after its last update was stopped partway", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    const stuck = job("deepgram", "queued", { updatedAt: "2026-09-08T09:50:00Z" });
    const r = asReported(stuck, now);
    expect(r.status).toBe("error");
    expect(r.error).toBe(TRANSCRIBE_DID_NOT_FINISH);
    const running = job("deepgram", "running", { updatedAt: "2026-09-27T11:40:00Z" });
    expect(asReported(running, now).status).toBe("error");
  });

  test("a real job updated within the window is still in progress", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    const fresh = job("deepgram", "queued", { updatedAt: new Date(now - STALE_JOB_MS + 1000).toISOString() });
    expect(asReported(fresh, now)).toEqual(fresh);
  });

  test("a finished job is never called stuck, however old", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    const done = job("deepgram", "done", { updatedAt: "2026-05-01T00:00:00Z" });
    expect(asReported(done, now)).toEqual(done);
  });

  test("the stored job is not changed", () => {
    const stored = job("stub", "queued");
    asReported(stored);
    expect(stored.status).toBe("queued");
  });
});
