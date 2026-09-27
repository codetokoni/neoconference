import { test, expect } from "@playwright/test";
import { byRecordingTime, isVideoKey } from "../../src/lib/eventRecordings";

/**
 * Which order a meeting's transcripts reach its summary in.
 *
 * Keys are recordings/<recorder>/<slug>/<start time>.mp4. Sorting the whole
 * key grouped two hosts' recordings by recorder id, so the second half of a
 * meeting could come before the first.
 */
test("recordings are ordered by start time, not by who recorded them", () => {
  const second = "recordings/user_A/weekly/2026-09-27-10-30-00.mp4";
  const first = "recordings/user_Z/weekly/2026-09-27-10-00-00.mp4";
  expect([second, first].sort(byRecordingTime)).toEqual([first, second]);
});

test("a meeting renamed between recordings still orders by time", () => {
  const before = "recordings/user_A/sync-2025/2026-09-01-09-00-00.mp4";
  const after = "recordings/user_A/weekly-sync/2026-09-08-09-00-00.mp4";
  expect([after, before].sort(byRecordingTime)).toEqual([before, after]);
});

test("audio sidecars are not recordings of their own", () => {
  expect(isVideoKey("recordings/u/s/2026-09-27-10-00-00.mp4")).toBe(true);
  expect(isVideoKey("recordings/u/s/2026-09-27-10-00-00.m4a.mp4")).toBe(false);
  expect(isVideoKey("recordings/u/s/2026-09-27-10-00-00.m4a")).toBe(false);
});
