// Run: npx tsx src/lib/__tests__/mediaDevices.smoke.ts
//
// The device lists the join page offers: virtual cameras included, the
// "default"/"communications" aliases Chrome adds on Windows left to the
// "System default" choice, placeholders before permission, and a remembered
// device that has been unplugged falling back to the default.

import assert from "node:assert/strict";
import { deviceOptions, stillThere } from "../../components/video/useMediaDevices";

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log("  ok  " + name);
};

const list = [
  { kind: "videoinput", deviceId: "cam-1", label: "Integrated Webcam" },
  { kind: "videoinput", deviceId: "cam-obs", label: "OBS Virtual Camera" },
  { kind: "videoinput", deviceId: "cam-vmix", label: "vMix Video" },
  { kind: "audioinput", deviceId: "default", label: "Default - Headset Microphone" },
  { kind: "audioinput", deviceId: "communications", label: "Communications - Headset Microphone" },
  { kind: "audioinput", deviceId: "mic-1", label: "Headset Microphone" },
  { kind: "audioinput", deviceId: "mic-1", label: "Headset Microphone" },
  { kind: "audiooutput", deviceId: "default", label: "Default - Speakers" },
  { kind: "audiooutput", deviceId: "spk-1", label: "Speakers" },
] as const;

t("cameras include virtual cameras, in the browser's order", () => {
  assert.deepEqual(
    deviceOptions([...list], "videoinput", "Camera").map((d) => d.label),
    ["Integrated Webcam", "OBS Virtual Camera", "vMix Video"],
  );
});

t("Chrome's default / communications aliases and duplicates are left out", () => {
  assert.deepEqual(deviceOptions([...list], "audioinput", "Microphone"), [{ deviceId: "mic-1", label: "Headset Microphone" }]);
  assert.deepEqual(deviceOptions([...list], "audiooutput", "Speaker"), [{ deviceId: "spk-1", label: "Speakers" }]);
});

t("before permission: unnamed devices get placeholders; id-less entries are skipped", () => {
  const before = [
    { kind: "videoinput", deviceId: "a", label: "" },
    { kind: "videoinput", deviceId: "b", label: "" },
    { kind: "audioinput", deviceId: "", label: "" },
  ] as const;
  assert.deepEqual(deviceOptions([...before], "videoinput", "Camera").map((d) => d.label), ["Camera 1", "Camera 2"]);
  assert.deepEqual(deviceOptions([...before], "audioinput", "Microphone"), []);
});

t("a remembered device that is no longer plugged in falls back to the system default", () => {
  const cams = deviceOptions([...list], "videoinput", "Camera");
  assert.equal(stillThere("cam-obs", cams), "cam-obs");
  assert.equal(stillThere("cam-gone", cams), "");
  assert.equal(stillThere("", cams), "");
});

console.log(`\n${n} checks passed`);
