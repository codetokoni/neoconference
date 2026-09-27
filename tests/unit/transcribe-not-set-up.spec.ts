import { test, expect } from "@playwright/test";
import { asReported, TRANSCRIBE_NOT_SET_UP } from "../../src/lib/transcribeNotSetUp";

const job = (
  provider: string,
  status: string,
  extra: { error?: string } = {}
): { id: string; recordingKey: string; provider: string; status: string; error?: string } => ({
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

  test("the stored job is not changed", () => {
    const stored = job("stub", "queued");
    asReported(stored);
    expect(stored.status).toBe("queued");
  });
});
