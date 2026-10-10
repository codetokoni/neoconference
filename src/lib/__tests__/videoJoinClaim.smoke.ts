// Run: npx tsx src/lib/__tests__/videoJoinClaim.smoke.ts
//
// Entering a code on /video/join, driven through the real POST
// /api/video/join with KV stood in for (./apiV1-stubs) and AMS answered by a
// stubbed fetch. A code held by another device is refused only while that
// slot is live on AMS; otherwise the new device takes it over. (Locks that
// outlived their device kept people out of their own code for 12 hours.)

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "./apiV1-stubs/install";

process.env.AMS_REST_BASE = "https://ams.test/rest/v2";

// AMS: which participant streams are broadcasting; "down" makes AMS fail.
const live = new Set<string>();
let amsDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://ams.test/")) return realFetch(input, init);
  if (amsDown) return new Response("busy", { status: 503 });
  const id = decodeURIComponent(url.split("/broadcasts/")[1] ?? "");
  return live.has(id)
    ? Response.json({ streamId: id, status: "broadcasting" })
    : Response.json({ streamId: id, status: "finished" });
}) as typeof fetch;

// The route's "[video-join]" log lines, parsed, in order.
const logs: Array<Record<string, unknown>> = [];
const rawLogs: string[] = [];
const realInfo = console.info;
console.info = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.startsWith("[video-join] ")) {
    rawLogs.push(line);
    logs.push(JSON.parse(line.slice("[video-join] ".length)));
    return;
  }
  realInfo(...args);
};
const lastLog = () => logs[logs.length - 1];
const fp = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 8);

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const route = await import("../../app/api/video/join/route");
  const codes = await import("../participantCodes");
  const { kv } = await import("../kv");

  const ROOM = "claimroom";
  let ip = 0;
  async function join(body: Record<string, unknown>) {
    const res = await route.POST(
      new Request(`https://www.neoconference.app/api/video/join?room=${ROOM}`, {
        method: "POST",
        // A fresh address per call: the route's per-IP limit is not under test.
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${++ip}` },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() };
  }

  await codes.mintCodes(ROOM, 2);
  const [grace, tunde] = await codes.listCodes(ROOM);
  const holder = (c: string) => kv.get<string>(`neo:video:claim:${ROOM}:${c}`);

  console.log("video join: a code held by another device");
  await t("the first device gets the code", async () => {
    const r = await join({ code: grace.code, deviceId: "phone" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.streamId, grace.streamId);
    assert.equal(await holder(grace.code), "phone");
    assert.deepEqual(lastLog(), { room: ROOM, slot: grace.slot, outcome: "new", ams: "not_asked", device: fp("phone"), holder: null });
  });

  await t("the same device comes back: rejoined", async () => {
    const r = await join({ code: grace.code, deviceId: "phone" });
    assert.equal(r.status, 200);
    assert.equal(r.body.rejoined, true);
    assert.equal(lastLog().outcome, "rejoined");
  });

  await t("another device while the slot is not live: takes the code over", async () => {
    const r = await join({ code: grace.code, deviceId: "laptop" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.rejoined, false);
    assert.equal(await holder(grace.code), "laptop");
    assert.deepEqual(lastLog(), { room: ROOM, slot: grace.slot, outcome: "took_over", ams: "not_live", device: fp("laptop"), holder: fp("phone") });
  });

  await t("another device while the slot is live: refused, and the holder keeps it", async () => {
    live.add(grace.streamId);
    const r = await join({ code: grace.code, deviceId: "phone" });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /live on another device/);
    assert.equal(await holder(grace.code), "laptop");
    assert.deepEqual(lastLog(), { room: ROOM, slot: grace.slot, outcome: "in_use", ams: "live", device: fp("phone"), holder: fp("laptop") });
  });

  await t("the live holder itself still rejoins", async () => {
    const r = await join({ code: grace.code, deviceId: "laptop" });
    assert.equal(r.status, 200);
    assert.equal(r.body.rejoined, true);
  });

  await t("AMS not answering: the claim stands (no takeover on a guess)", async () => {
    live.delete(grace.streamId);
    amsDown = true;
    const r = await join({ code: grace.code, deviceId: "tablet" });
    assert.equal(r.status, 409);
    assert.equal(await holder(grace.code), "laptop");
    // The log tells this refusal apart from a real "live elsewhere".
    assert.equal(lastLog().outcome, "in_use");
    assert.equal(lastLog().ams, "no_answer");
    amsDown = false;
  });

  await t("one person's live slot does not lock another's code", async () => {
    live.add(grace.streamId);
    await join({ code: tunde.code, deviceId: "t-phone" });
    const r = await join({ code: tunde.code, deviceId: "t-laptop" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await holder(tunde.code), "t-laptop");
  });

  await t("an unknown code is still refused as not on the list", async () => {
    const r = await join({ code: "000000", deviceId: "phone" });
    assert.equal(r.status, 404);
    assert.deepEqual(lastLog(), { room: ROOM, slot: null, outcome: "unknown_code", ams: "not_asked", device: fp("phone"), holder: null });
  });

  await t("Leave is logged with the slot, and frees the code", async () => {
    const r = await join({ code: grace.code, deviceId: "laptop", leave: true });
    assert.equal(r.status, 200);
    assert.deepEqual(lastLog(), { room: ROOM, slot: grace.slot, outcome: "left", device: fp("laptop") });
    assert.equal(await holder(grace.code), null);
  });

  await t("no log line ever carries a code or a raw device id", async () => {
    assert.ok(rawLogs.length >= 9, String(rawLogs.length));
    for (const line of rawLogs) {
      for (const secret of [grace.code, tunde.code, "000000", "phone", "laptop", "tablet"]) {
        assert.ok(!line.includes(secret), `"${secret}" in ${line}`);
      }
    }
  });

  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
