// Run: npx tsx src/lib/__tests__/meetingCatchUp.smoke.ts
//
// "What did I miss?" in a meeting, through the real POST /api/meeting-transcript
// and GET /api/meeting-catchup, with KV and Clerk stood in for (./apiV1-stubs)
// and the AI answered by a stubbed fetch.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.OPENAI_API_KEY = "sk-test";

const aiCalls: Array<{ system: string; user: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "https://api.openai.com/v1/chat/completions") {
    const body = JSON.parse(String(init?.body));
    aiCalls.push({ system: body.messages[0].content, user: body.messages[1].content });
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ summary: "Ada opened; Ben gave the budget.", points: ["Budget is 5,000"] }) } }],
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

const who = (id: string | null) => ((globalThis as { __who?: string }).__who = id ?? undefined);

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const ingest = await import("../../app/api/meeting-transcript/route");
  const catchup = await import("../../app/api/meeting-catchup/route");
  const { kv } = await import("../kv");
  const ROOM = "team-sync";

  async function send(segments: unknown[]) {
    const res = await ingest.POST(
      new Request(`https://www.neoconference.app/api/meeting-transcript?room=${ROOM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segments }),
      }),
    );
    return { status: res.status, body: (await res.json()) as { added?: number } };
  }
  async function ask(lang: string, room = ROOM) {
    const res = await catchup.GET(new Request(`https://www.neoconference.app/api/meeting-catchup?room=${room}&lang=${lang}`));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  console.log("meeting catch-up");
  await t("sending captions and asking both need a signed-in account", async () => {
    who(null);
    assert.equal((await send([{ id: "s1", speaker: "Ada", text: "Welcome." }])).status, 401);
    assert.equal((await ask("fr")).status, 401);
    assert.equal(aiCalls.length, 0);
  });

  await t("no captions yet: nothing_yet, no AI call", async () => {
    who("user_a");
    assert.equal((await ask("fr")).body.status, "nothing_yet");
    assert.equal(aiCalls.length, 0);
  });

  await t("the same sentence from three pages is kept once", async () => {
    who("user_a");
    assert.equal((await send([{ id: "s1", speaker: "Ada", text: "Welcome, everyone." }])).body.added, 1);
    who("user_b");
    assert.equal((await send([{ id: "s1", speaker: "Ada", text: "Welcome, everyone." }])).body.added, 0);
    who("user_c");
    const r = await send([
      { id: "s1", speaker: "Ada", text: "Welcome, everyone." },
      { id: "s2", speaker: "Ben", text: "The budget is five thousand." },
      { id: "", speaker: "X", text: "no id" },
      { id: "s3", speaker: "Ben", text: "   " },
    ]);
    assert.equal(r.body.added, 1);
    assert.equal(await kv.hlen(`neo:meeting:tx:${ROOM}`), 2);
  });

  await t("a summary in French, with the speakers named in what the AI reads", async () => {
    const r = await ask("fr");
    assert.equal(r.body.status, "ready");
    assert.equal(aiCalls.length, 1);
    assert.match(aiCalls[0].system, /Write in French only/);
    assert.match(aiCalls[0].user, /Ada: Welcome, everyone\.\nBen: The budget is five thousand\./);
  });

  await t("others asking in French share it", async () => {
    who("user_b");
    for (let i = 0; i < 4; i++) assert.equal((await ask("fr")).body.status, "ready");
    assert.equal(aiCalls.length, 1);
  });

  await t("kept apart from an event room of the same name", async () => {
    assert.equal(await kv.get(`neo:video:catchup:${ROOM}:fr`), null);
    assert.ok(await kv.get(`neo:video:catchup:meeting:${ROOM}:fr`));
  });

  await t("a language that is not offered is refused", async () => {
    assert.equal((await ask("xx")).status, 400);
  });

  await t("a meeting's transcript stops growing at its cap", async () => {
    const big = "big-room";
    const key = `neo:meeting:tx:${big}`;
    const fill: Record<string, string> = {};
    for (let i = 0; i < 4000; i++) fill[`x${i}`] = JSON.stringify({ s: "", t: "x", ts: 1 });
    await kv.hset(key, fill);
    const res = await ingest.POST(
      new Request(`https://www.neoconference.app/api/meeting-transcript?room=${big}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segments: [{ id: "new", speaker: "A", text: "one more" }] }),
      }),
    );
    assert.equal(((await res.json()) as { added: number }).added, 0);
    assert.equal(await kv.hlen(key), 4000);
  });

  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
