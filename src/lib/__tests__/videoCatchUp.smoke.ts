// Run: npx tsx src/lib/__tests__/videoCatchUp.smoke.ts
//
// "What did I miss?" through the real GET /api/video/catchup, with KV stood
// in for (./apiV1-stubs), the translation worker's transcript and the AI
// answered by a stubbed fetch. Checks the cost bounds: one shared summary
// per room and language, no AI call without new speech, and only the
// languages the room offers.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.NEXT_PUBLIC_TRANSLATION_SSE = "https://worker.test";
process.env.OPENAI_API_KEY = "sk-test";

const MIN = 60_000;
let transcript: Array<{ text: string; original?: string; ts: number; seq: number; lang: string }> = [];
const aiCalls: Array<{ system: string; user: string }> = [];
let aiFails = false;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://worker.test/transcript/")) {
    return Response.json({ ok: true, lines: transcript });
  }
  if (url === "https://api.openai.com/v1/chat/completions") {
    const body = JSON.parse(String(init?.body));
    aiCalls.push({ system: body.messages[0].content, user: body.messages[1].content });
    if (aiFails) return new Response("upstream", { status: 502 });
    const fr = /French/.test(body.messages[0].content);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify(
              fr
                ? { summary: "Le pasteur a parlé de la foi.", points: ["Lisez Hébreux 11", "Priez à 21 h"] }
                : { summary: "The pastor spoke about faith.", points: ["Read Hebrews 11"] },
            ),
          },
        },
      ],
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const route = await import("../../app/api/video/catchup/route");
  const { kv } = await import("../kv");
  const ROOM = "crusade";

  async function ask(lang: string) {
    const res = await route.GET(new Request(`https://www.neoconference.app/api/video/catchup?room=${ROOM}&lang=${lang}`));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  // KV (like Upstash) hands JSON back parsed.
  const stored = async (lang: string) => {
    const raw = await kv.get(`neo:video:catchup:${ROOM}:${lang}`);
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as { at: number };
  };
  const now = Date.now();
  const line = (seq: number, minsAgo: number, text: string) => ({ seq, ts: now - minsAgo * MIN, text, original: text, lang: "en" });

  console.log("video catch-up: what did I miss?");
  await t("a language the room does not offer is refused, and never reaches the AI", async () => {
    const r = await ask("xx");
    assert.equal(r.status, 400);
    assert.equal(aiCalls.length, 0);
  });

  await t("nothing said yet: nothing_yet, no AI call", async () => {
    const r = await ask("fr");
    assert.deepEqual(r.body, { ok: true, status: "nothing_yet" });
    assert.equal(aiCalls.length, 0);
  });

  await t("only yesterday's programme in the transcript: nothing_yet", async () => {
    transcript = [line(1, 26 * 60, "Yesterday's sermon about patience.")];
    assert.equal((await ask("fr")).body.status, "nothing_yet");
    assert.equal(aiCalls.length, 0);
  });

  await t("today's programme: a summary in French, made from today's lines only", async () => {
    transcript = [
      line(1, 26 * 60, "Yesterday's sermon about patience."),
      line(2, 40, "Welcome everyone to the crusade."),
      line(3, 20, "Turn with me to Hebrews 11."),
      line(4, 1, "We will pray at 9 pm."),
    ];
    const r = await ask("fr");
    assert.equal(r.body.status, "ready");
    assert.equal(r.body.summary, "Le pasteur a parlé de la foi.");
    assert.deepEqual(r.body.points, ["Lisez Hébreux 11", "Priez à 21 h"]);
    assert.equal(r.body.minutes, 39);
    assert.equal(aiCalls.length, 1);
    assert.match(aiCalls[0].system, /Write in French only/);
    assert.match(aiCalls[0].user, /Hebrews 11/);
    assert.ok(!aiCalls[0].user.includes("patience"), "yesterday's line was sent");
  });

  await t("many viewers asking in French share that one summary", async () => {
    for (let i = 0; i < 5; i++) assert.equal((await ask("fr")).body.summary, "Le pasteur a parlé de la foi.");
    assert.equal(aiCalls.length, 1);
  });

  await t("another language is its own summary", async () => {
    const r = await ask("es");
    assert.equal(r.body.status, "ready");
    assert.equal(aiCalls.length, 2);
    assert.match(aiCalls[1].system, /Write in Spanish only/);
  });

  await t("after 2 minutes with nothing new said: kept, no AI call", async () => {
    const c = await stored("fr");
    await kv.set(`neo:video:catchup:${ROOM}:fr`, JSON.stringify({ ...c, at: c.at - 3 * MIN }));
    assert.equal((await ask("fr")).body.status, "ready");
    assert.equal(aiCalls.length, 2);
  });

  await t("new speech within 2 minutes: still the shared summary, no AI call", async () => {
    transcript.push(line(5, 0, "Stand with me."));
    assert.equal((await ask("fr")).body.summary, "Le pasteur a parlé de la foi.");
    assert.equal(aiCalls.length, 2);
  });

  await t("after 2 minutes with new speech: remade", async () => {
    transcript.push(line(6, 0, "Lift your hands."));
    const c = await stored("fr");
    await kv.set(`neo:video:catchup:${ROOM}:fr`, JSON.stringify({ ...c, at: c.at - 3 * MIN }));
    await ask("fr");
    assert.equal(aiCalls.length, 3);
    assert.match(aiCalls[2].user, /Lift your hands/);
  });

  await t("the AI failing keeps the last summary", async () => {
    aiFails = true;
    transcript.push(line(7, 0, "Amen."));
    const c = await stored("fr");
    await kv.set(`neo:video:catchup:${ROOM}:fr`, JSON.stringify({ ...c, at: c.at - 3 * MIN }));
    const r = await ask("fr");
    assert.equal(r.body.summary, "Le pasteur a parlé de la foi.");
  });

  await t("the AI failing with no summary yet: failed", async () => {
    const r = await ask("pt");
    assert.equal(r.body.status, "failed");
    aiFails = false;
  });

  await t("while another request is making it and none exists yet: busy", async () => {
    await kv.set(`neo:video:catchup:lock:${ROOM}:ar`, 1);
    const before = aiCalls.length;
    assert.equal((await ask("ar")).body.status, "busy");
    assert.equal(aiCalls.length, before);
    await kv.del(`neo:video:catchup:lock:${ROOM}:ar`);
    assert.equal((await ask("ar")).body.status, "ready");
  });

  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
