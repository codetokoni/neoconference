import { test, expect } from "@playwright/test";
import { recordedAtFromKey, replayOpen, replayVideoKeys, sizeLabel } from "../../src/lib/replayRecordings";

test("replay is open unless the owner switched it off", () => {
  expect(replayOpen({})).toBe(true);
  expect(replayOpen({ replayEnabled: true })).toBe(true);
  expect(replayOpen({ replayEnabled: false })).toBe(false);
});

/**
 * The replay page shows a meeting's recordings to anyone with the link:
 * the videos, newest first, never the audio sidecars.
 */
test("the recording time is read from the key", () => {
  expect(recordedAtFromKey("recordings/user_x/falf/2026-09-28-17-12-44.mp4")).toBe("2026-09-28T17:12:44.000Z");
  expect(recordedAtFromKey("recordings/user_x/falf/odd-name.mp4")).toBeNull();
});

test("videos only, once each, newest first", () => {
  const keys = replayVideoKeys([
    { key: "recordings/user_a/falf/2026-09-28-16-26-41.mp4", size: 100 },
    { key: "recordings/user_a/falf/2026-09-28-16-26-41.m4a.mp4", size: 50 },
    { key: "recordings/user_b/falf/2026-09-28-17-12-44.mp4", size: 300 },
    { key: "recordings/user_b/falf/2026-09-28-17-12-44.mp4", size: 300 },
    { key: "recordings/user_a/falf/2026-09-27-19-16-15.mp4", size: 0 },
  ]).map((o) => o.key);
  expect(keys).toEqual([
    "recordings/user_b/falf/2026-09-28-17-12-44.mp4",
    "recordings/user_a/falf/2026-09-28-16-26-41.mp4",
  ]);
});

test("sizes read as people say them", () => {
  expect(sizeLabel(2349454)).toBe("2.2 MB");
  expect(sizeLabel(50628)).toBe("49 KB");
  expect(sizeLabel(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
});
