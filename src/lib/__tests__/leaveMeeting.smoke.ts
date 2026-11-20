// Run: npx tsx src/lib/__tests__/leaveMeeting.smoke.ts
//
// Leaving a meeting asks how it went (src/components/conference/leaveMeeting.ts).
// On a phone, Leave used to go straight to "/" with a full page load, which
// overrode the room's redirect: nobody leaving on a phone was asked
// (2026-11-20).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterLeaveUrl, leaveMeeting } from "../../components/conference/leaveMeeting";

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log("  ok  " + name);
};

t("after leaving a meeting: its feedback page, stars first", () => {
  assert.equal(afterLeaveUrl("saregionalmeeting"), "/feedback/saregionalmeeting?after=1");
  assert.equal(afterLeaveUrl("a b/c"), "/feedback/a%20b%2Fc?after=1");
  assert.equal(afterLeaveUrl(""), "/");
  assert.equal(afterLeaveUrl(null), "/");
});

t("Leave disconnects, then goes there; a room that is already gone still leaves", () => {
  const did: string[] = [];
  leaveMeeting({ disconnect: () => did.push("disconnect") }, "sa", (url) => did.push(url));
  assert.deepEqual(did, ["disconnect", "/feedback/sa?after=1"]);
  const after: string[] = [];
  leaveMeeting({ disconnect: () => { throw new Error("closed"); } }, "sa", (url) => after.push(url));
  leaveMeeting(undefined, "sa", (url) => after.push(url));
  assert.deepEqual(after, ["/feedback/sa?after=1", "/feedback/sa?after=1"]);
});

t("the phone layout's Leave and the room's onLeave both use it; nothing sends a leaver home by hand", () => {
  const src = (p: string) => readFileSync(path.resolve(__dirname, "../../", p), "utf8");
  const phone = src("components/MobileVideoConference.tsx");
  assert.match(phone, /leaveMeeting\(room, slug\)/);
  assert.doesNotMatch(phone, /location\.href\s*=\s*['"]\/['"]/, "a full page load to / overrides the redirect");
  assert.match(src("app/room/[name]/page.tsx"), /onLeave=\{\(\) => router\.push\(afterLeaveUrl\(eventSlug\)\)\}/);
});

console.log(`leaveMeeting: ${n} checks passed`);
