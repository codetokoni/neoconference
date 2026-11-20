// Run: npx tsx src/lib/__tests__/roomOptions.smoke.ts
//
// The web meeting room receives only the videos on screen (adaptiveStream)
// and cameras send only the layers watched (dynacast). Without them, a
// 700-person meeting on 20 November 2026 overwhelmed phones: LiveKit's client
// timed out and rejoined every ~20 s (src/components/conference/roomOptions.ts).
// This keeps the room from losing them in a later edit.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { joinMedia, ROOM_OPTIONS } from "../../components/conference/roomOptions";

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log("  ok  " + name);
};

t("both are on, and video does not pause in the background (the floating window)", () => {
  assert.deepEqual(ROOM_OPTIONS.adaptiveStream, { pauseVideoInBackground: false });
  assert.equal(ROOM_OPTIONS.dynacast, true);
});

t("the meeting room passes them to its LiveKitRoom", () => {
  const page = readFileSync(join(process.cwd(), "src/app/room/[name]/page.tsx"), "utf8");
  const room = page.slice(page.indexOf("<LiveKitRoom"), page.indexOf(">", page.indexOf("onDisconnected={onLeave}")));
  assert.ok(room.includes("options={ROOM_OPTIONS}"), "LiveKitRoom options");
});

t("on joining, only what was chosen is published: off stays off, a chosen device is asked for", () => {
  assert.equal(joinMedia(false, undefined), false);
  assert.equal(joinMedia(false, "cam-2"), false, "a device does not turn it on");
  assert.equal(joinMedia(true, undefined), true);
  assert.equal(joinMedia(undefined, undefined), true, "no choice made: on, as before");
  assert.deepEqual(joinMedia(true, "cam-2"), { deviceId: { ideal: "cam-2" } });
});

t("the meeting room publishes by the join screen's choices", () => {
  const page = readFileSync(join(process.cwd(), "src/app/room/[name]/page.tsx"), "utf8");
  const room = page.slice(page.indexOf("<LiveKitRoom"), page.indexOf(">", page.indexOf("onDisconnected={onLeave}")));
  assert.ok(room.includes("audio={joinMedia(choices.audioEnabled, choices.audioDeviceId)}"));
  assert.ok(room.includes("video={joinMedia(choices.videoEnabled, choices.videoDeviceId)}"));
});

t("the partner zone and embedded meeting pages receive only the videos on screen too", () => {
  for (const f of ["src/app/embed/zone/page.tsx", "src/app/embed/meeting/page.tsx"]) {
    const page = readFileSync(join(process.cwd(), f), "utf8");
    const room = page.slice(page.indexOf("<LiveKitRoom"), page.indexOf("<LiveKitRoom") + 1500);
    assert.ok(room.includes("options={ROOM_OPTIONS}"), f);
  }
});

console.log(`\n${n} checks passed`);
