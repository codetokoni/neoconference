// Run: npx tsx src/lib/__tests__/videoQueueAuto.smoke.ts
//
// Queues that fill themselves with whoever is live, driven through the real
// /api/video/queues routes with KV and Clerk stood in for (./apiV1-stubs)
// and AMS answered by a stubbed fetch. A person removed or taken to air is
// not put straight back, and a save from a page that has not seen the
// latest additions does not drop them.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.AMS_REST_BASE = "https://ams.test/rest/v2";

const live = new Set<string>();
let amsDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://ams.test/")) return realFetch(input, init);
  if (amsDown) return new Response("busy", { status: 503 });
  if (url.includes("/subtracks")) {
    return Response.json([...live].map((streamId) => ({ streamId, status: "broadcasting" })));
  }
  return Response.json({ status: "finished" });
}) as typeof fetch;

(globalThis as { __who?: string }).__who = "user_mod";

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const list = await import("../../app/api/video/queues/route");
  const one = await import("../../app/api/video/queues/[slug]/route");
  const codes = await import("../participantCodes");

  const ROOM = "qroom";
  const base = "https://www.neoconference.app/api/video/queues";
  type Q = { slug: string; name: string; order: string[]; auto: boolean };

  async function create(name: string, auto?: boolean) {
    const res = await list.POST(
      new Request(`${base}?room=${ROOM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(auto === undefined ? { name } : { name, auto }),
      }),
    );
    return (await res.json()) as { ok: boolean; queue: Q };
  }
  async function read(slug: string) {
    const res = await one.GET(new Request(`${base}/${slug}?room=${ROOM}`), { params: { slug } });
    return (await res.json()) as { ok: boolean; queue: Q; at: number };
  }
  async function save(slug: string, body: Record<string, unknown>) {
    const res = await one.PATCH(
      new Request(`${base}/${slug}?room=${ROOM}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: { slug } },
    );
    return (await res.json()) as { ok: boolean; queue: Q; at: number };
  }
  const tick = () => new Promise((r) => setTimeout(r, 3));

  await codes.mintCodes(ROOM, 8);
  const people = await codes.listCodes(ROOM);
  const sid = (slot: number) => people.find((p) => p.slot === slot)!.streamId;

  console.log("queues: add live people automatically");
  await t("a new queue with auto on fills with everyone live, in slot order", async () => {
    live.add(sid(5));
    live.add(sid(2));
    live.add(sid(7));
    const c = await create("Testimonies", true);
    assert.equal(c.queue.auto, true);
    const q = (await read("testimonies")).queue;
    assert.deepEqual(q.order, [sid(2), sid(5), sid(7)]);
  });

  await t("someone who goes live later joins the end", async () => {
    live.add(sid(1));
    const q = (await read("testimonies")).queue;
    assert.deepEqual(q.order, [sid(2), sid(5), sid(7), sid(1)]);
  });

  await t("removed or taken to air: not put back while still live", async () => {
    const r = await read("testimonies");
    // Taking sid(2) to air drops it from the queue; removing sid(7) likewise.
    await save("testimonies", { order: [sid(5), sid(1)], since: r.at });
    const q = (await read("testimonies")).queue;
    assert.deepEqual(q.order, [sid(5), sid(1)]);
  });

  await t("a save from a page that has not seen a fresh addition keeps it", async () => {
    const stale = await read("testimonies"); // the producer's page loads
    await tick();
    live.add(sid(3));
    await read("testimonies"); // another board's read adds sid(3)
    // The producer reorders from their stale list (no sid(3) in it).
    const r = await save("testimonies", { order: [sid(1), sid(5)], since: stale.at });
    assert.deepEqual(r.queue.order, [sid(1), sid(5), sid(3)]);
  });

  await t("removing someone the page did see is honoured", async () => {
    const r = await read("testimonies");
    const s = await save("testimonies", { order: [sid(1), sid(5)], since: r.at });
    assert.deepEqual(s.queue.order, [sid(1), sid(5)]);
    assert.deepEqual((await read("testimonies")).queue.order, [sid(1), sid(5)]);
  });

  await t("a person added by hand and then removed is not put back either", async () => {
    live.add(sid(8));
    const q = await create("Prayer", false);
    assert.equal(q.queue.auto, false);
    await save("prayer", { order: [sid(8)] });
    await save("prayer", { order: [] });
    await save("prayer", { auto: true });
    const order = (await read("prayer")).queue.order;
    assert.ok(!order.includes(sid(8)), order.join(","));
  });

  await t("auto off: nobody new is added; on again: the live people not yet seen join", async () => {
    await save("testimonies", { auto: false });
    live.add(sid(4));
    assert.deepEqual((await read("testimonies")).queue.order, [sid(1), sid(5)]);
    const on = await save("testimonies", { auto: true });
    assert.equal(on.queue.auto, true);
    // Slots 4 and 8 are live and were never in this queue (8 went live above).
    assert.deepEqual((await read("testimonies")).queue.order, [sid(1), sid(5), sid(4), sid(8)]);
  });

  await t("a queue created without the option stays as built by hand", async () => {
    await create("Manual");
    assert.deepEqual((await read("manual")).queue.order, []);
  });

  await t("someone signed out by a moderator is not added", async () => {
    const six = people.find((p) => p.slot === 6)!;
    await codes.signOutCode(ROOM, six.code);
    live.add(six.streamId);
    await create("Late", true);
    assert.ok(!(await read("late")).queue.order.includes(six.streamId));
  });

  await t("AMS not answering: nothing is added and the read still works", async () => {
    amsDown = true;
    await create("Quiet", true);
    const r = await read("quiet");
    assert.equal(r.ok, true);
    assert.deepEqual(r.queue.order, []);
    amsDown = false;
  });

  await t("a long queue is kept whole (more than the old 200 cap)", async () => {
    const order = Array.from({ length: 260 }, (_, i) => `qroom-x${i}`);
    const r = await save("manual", { order });
    assert.equal(r.queue.order.length, 260);
  });

  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
