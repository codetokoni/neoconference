// Run: npx tsx src/lib/__tests__/partnerPrayerTimer.smoke.ts
//
// The zone embed with an integration's "Show the prayer timer" on or off
// (src/app/embed/zone/PrayerTimer.tsx ZoneTimer). On: the counter, with the
// page's onTick, which is what sends prayer-time events to the partner's
// page. Off (NeoStream): nothing on screen and no onTick, but the heartbeat
// stays — without it a room of listeners on locked phones closes as idle.
// The server side (redeem's features.prayerTimer, the admin setting) is in
// adminPartners.smoke.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ReactElement } from "react";

let finished = false;
process.on("exit", (code) => {
  if (code === 0 && !finished) {
    console.error("exited before the last check — something never answered");
    process.exitCode = 1;
  }
});

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const React = await import("react");
  // This runner compiles JSX to React.createElement (Next does not need the global).
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  // The component's own copy: a dynamic import here loads the ESM build,
  // a second RoomContext the component never reads.
  const req = createRequire(join(process.cwd(), "src/app/embed/zone/PrayerTimer.tsx"));
  const { RoomContext } = req("@livekit/components-react") as typeof import("@livekit/components-react");
  const { Room } = req("livekit-client") as typeof import("livekit-client");
  const M = await import("../../app/embed/zone/PrayerTimer");

  const getSession = () => "session";
  const onTick = () => {};
  /** Rendered inside a LiveKit room, as the embed page renders it. */
  const render = (el: ReactElement) => renderToStaticMarkup(React.createElement(RoomContext.Provider, { value: new Room() }, el));

  await t("on: the prayer timer, given the page's onTick (the prayer-time events)", () => {
    const el = M.ZoneTimer({ prayerTimer: true, getSession, onTick }) as ReactElement<{ onTick?: unknown; getSession?: unknown }>;
    assert.equal(el.type, M.PrayerTimer);
    assert.equal(el.props.onTick, onTick);
    assert.equal(el.props.getSession, getSession);
    const html = render(React.createElement(M.ZoneTimer, { prayerTimer: true, getSession, onTick }));
    assert.match(html, /Your Prayer Time/);
    assert.match(html, /role="timer"/);
    assert.match(html, /00:00:00/);
  });

  await t("off: nothing on screen and no onTick, but the heartbeat still runs", () => {
    const el = M.ZoneTimer({ prayerTimer: false, getSession, onTick }) as ReactElement<{ onTick?: unknown; getSession?: unknown }>;
    // The beat alone: AttendanceBeat runs useAttendanceBeat, as PrayerTimer does.
    assert.equal(el.type, M.AttendanceBeat);
    assert.equal(el.props.getSession, getSession);
    assert.ok(!("onTick" in el.props), "no onTick, so no prayer-time events reach the partner's page");
    assert.equal(render(React.createElement(M.ZoneTimer, { prayerTimer: false, getSession, onTick })), "");
    // It does read the room (the beat needs its connection and sid): outside one it refuses.
    assert.throws(() => renderToStaticMarkup(React.createElement(M.AttendanceBeat, { getSession })), /outside of livekit room/);
    // Both share the one beat; neither has a schedule of its own.
    const src = readFileSync("src/app/embed/zone/PrayerTimer.tsx", "utf8");
    const body = (name: string) => src.slice(src.indexOf(`export function ${name}(`)).split(/\r?\n\}\r?\n/)[0];
    assert.match(body("AttendanceBeat"), /useAttendanceBeat\(getSession\)/);
    assert.match(body("PrayerTimer"), /useAttendanceBeat\(getSession,/);
    assert.match(body("useAttendanceBeat"), /startBeating\(/);
    assert.equal(src.match(/startBeating\(/g)?.length, 1);
  });

  await t("the embed page renders the counter and the after-leaving total only where the server said so", () => {
    const src = readFileSync("src/app/embed/zone/page.tsx", "utf8");
    // The setting comes from redeem's answer, and is off until it arrives.
    assert.match(src, /useState<Features>\(\{ prayerTimer: false \}\)/);
    assert.match(src, /setFeatures\(\{ prayerTimer: r\.features\?\.prayerTimer === true \}\)/);
    assert.match(src, /<ZoneTimer prayerTimer=\{features\.prayerTimer\}/);
    assert.equal(src.match(/<PrayerTimeSoFar /g)?.length, 2);
    assert.equal(src.match(/\{features\.prayerTimer && <PrayerTimeSoFar /g)?.length, 2);
    // Only PrayerTimer is given the tick that sends prayer-time.
    assert.equal(src.match(/onPrayerTick/g)?.length, 2, "defined once, passed once (to ZoneTimer)");
    assert.doesNotMatch(src, /<PrayerTimer /);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
