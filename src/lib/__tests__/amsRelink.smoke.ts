// Run: npx tsx src/lib/__tests__/amsRelink.smoke.ts
//
// When vMix/OBS reconnects, AMS 3.0 makes <room>-video afresh with no main
// track, and the room's group has nothing to play over WebRTC (8 Oct 2026).
// relinkVideoSubtrack puts it back with AMS's "add subtrack" call. Driven
// here against a fake AMS that records every request.

import assert from "node:assert/strict";

process.env.AMS_REST_BASE = "https://ams.test/LiveApp/rest/v2";

type Call = { method: string; url: string };

function fakeAms(video: { status: string; mainTrackStreamId: string | null } | null, addOk = true) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (method === "GET" && url.endsWith("/broadcasts/neoconf-video")) {
      return video ? new Response(JSON.stringify({ streamId: "neoconf-video", ...video })) : new Response("", { status: 404 });
    }
    if (method === "POST" && url.endsWith("/broadcasts/create")) {
      return new Response(JSON.stringify({ success: false, message: "Stream id is already being used" }));
    }
    if (method === "POST" && url.includes("/subtrack?")) {
      return new Response(JSON.stringify({ success: addOk, message: addOk ? "" : "nope" }));
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return calls;
}

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const { relinkVideoSubtrack } = await import("../amsMainTrack");
  console.log("relink the programme into its room");

  await t("a live programme outside the group is added back as a subtrack", async () => {
    const calls = fakeAms({ status: "broadcasting", mainTrackStreamId: "" });
    const res = await relinkVideoSubtrack("neoconf");
    assert.deepEqual(res, { ok: true, created: true });
    const add = calls.find((c) => c.url.includes("/subtrack?"));
    assert.ok(add, "no add-subtrack call");
    assert.equal(add.method, "POST");
    assert.equal(add.url, "https://ams.test/LiveApp/rest/v2/broadcasts/neoconf-room/subtrack?id=neoconf-video");
  });

  await t("already in the group: nothing is written", async () => {
    const calls = fakeAms({ status: "broadcasting", mainTrackStreamId: "neoconf-room" });
    assert.deepEqual(await relinkVideoSubtrack("neoconf"), { ok: true, created: false });
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  });

  await t("not broadcasting, or not there: nothing is written", async () => {
    let calls = fakeAms({ status: "finished", mainTrackStreamId: "" });
    await relinkVideoSubtrack("neoconf");
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
    calls = fakeAms(null);
    const res = await relinkVideoSubtrack("neoconf");
    assert.equal(res.ok, false);
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  });

  await t("AMS refusing the add is reported, not swallowed as success", async () => {
    fakeAms({ status: "broadcasting", mainTrackStreamId: null }, false);
    const res = await relinkVideoSubtrack("neoconf");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /nope/);
  });

  console.log(`\n${n} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
