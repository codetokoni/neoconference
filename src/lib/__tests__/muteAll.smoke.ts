// src/lib/__tests__/muteAll.smoke.ts
//
// "Mute all" kept the host on "Muting…" (2026-11-06, a screenshot from a
// meeting): the route muted one microphone at a time, waiting for each
// LiveKit call, already-muted microphones and people who had just left
// included. src/lib/muteAll.ts decides who to mute and runs the calls a few
// at a time; this checks both, and that a slow room is done in about the
// time of one call per batch, not one per person.

import assert from "node:assert/strict";
import { MUTE_CONCURRENCY, planMuteAll, runLimited, type RoomParticipant } from "../muteAll";

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

const mic = (sid: string, muted = false) => ({ sid, source: 2, type: 0, muted });
const cam = (sid: string) => ({ sid, source: 1, type: 1, muted: false });
const person = (identity: string, role: string | null, tracks: RoomParticipant["tracks"]): RoomParticipant => ({
  identity,
  metadata: role ? JSON.stringify({ role }) : "",
  tracks,
});

async function main() {
  await t("only ordinary people's live microphones are muted", () => {
    const list = [
      person("user_host#1", "host", [mic("TR_h")]),
      person("user_mod#1", "cohost", [mic("TR_m")]),
      person("user_me#2", "attendee", [mic("TR_me")]), // the caller, on another device
      person("user_spk#1", "attendee", [mic("TR_s")]), // "Mute everyone else" keeps them
      person("user_a#1", "attendee", [mic("TR_a"), cam("TR_acam")]),
      person("user_b#1", null, [mic("TR_b", true)]), // already muted: no call
      person("user_c#1", "attendee", [{ sid: "TR_c", source: "MICROPHONE", muted: false }]),
      person("user_d#1", "attendee", [{ sid: "TR_d", type: "AUDIO" }]), // no source: by type
      person("user_e#1", "attendee", [cam("TR_ecam")]), // no microphone at all
    ];
    const plan = planMuteAll(list, { actorId: "USER_ME", exceptBase: "user_spk" });
    assert.deepEqual(
      plan.jobs.map((j) => j.trackSid),
      ["TR_a", "TR_c", "TR_d"],
    );
    assert.equal(plan.jobs[0].identity, "user_a#1");
    assert.equal(plan.skipped, 4);
    assert.equal(plan.alreadyMuted, 1);
  });

  await t("bad metadata is an ordinary participant, not a crash", () => {
    const plan = planMuteAll([{ identity: "user_x#1", metadata: "{not json", tracks: [mic("TR_x")] }], {
      actorId: "",
      exceptBase: "",
    });
    assert.deepEqual(plan.jobs.map((j) => j.trackSid), ["TR_x"]);
  });

  await t("a room of 120 is muted a batch at a time, not one call after another", async () => {
    const jobs = Array.from({ length: 120 }, (_, i) => ({ identity: `user_${i}#1`, trackSid: `TR_${i}` }));
    let inFlight = 0;
    let most = 0;
    const done = new Set<string>();
    const started = Date.now();
    const result = await runLimited(jobs, MUTE_CONCURRENCY, async (j) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 40)); // one LiveKit call
      inFlight--;
      done.add(j.trackSid);
    });
    const ms = Date.now() - started;
    assert.equal(result.ok, 120);
    assert.equal(result.failed, 0);
    assert.equal(done.size, 120);
    assert.equal(most, MUTE_CONCURRENCY, "never more than the limit at once, and the limit is used");
    // One after another: 120 x 40 ms = 4.8 s. A batch at a time: 10 x 40 ms.
    assert.ok(ms < 1500, `took ${ms} ms`);
  });

  await t("people who left in the meantime fail on their own; everyone else is still muted", async () => {
    const jobs = ["a", "gone1", "b", "gone2", "c"].map((x) => ({ identity: `user_${x}#1`, trackSid: `TR_${x}` }));
    const muted: string[] = [];
    const result = await runLimited(jobs, 2, async (j) => {
      if (j.identity.includes("gone")) throw new Error("Not Found: participant does not exist");
      muted.push(j.trackSid);
    });
    assert.deepEqual(result, { ok: 3, failed: 2 });
    assert.deepEqual(muted.sort(), ["TR_a", "TR_b", "TR_c"]);
  });

  await t("nothing to mute is done at once", async () => {
    assert.deepEqual(await runLimited([], MUTE_CONCURRENCY, async () => {}), { ok: 0, failed: 0 });
  });

  console.log(`muteAll: ${n} checks passed`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
