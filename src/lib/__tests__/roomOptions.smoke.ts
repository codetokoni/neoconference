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
import { ROOM_OPTIONS } from "../../components/conference/roomOptions";

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

console.log(`\n${n} checks passed`);
