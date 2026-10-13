// Run: npx tsx src/lib/__tests__/translationPlan.smoke.ts
//
// Live translation is on the Pro plan and above, by the meeting OWNER's plan:
// /api/translate refuses a caption of a meeting whose owner is on Free or
// Starter (402 translation_needs_pro), translates one of a Pro meeting for
// any listener, and lets through a request that names no meeting (app 1.2.4
// and older) while logging it once. Driven through the real route with Clerk
// and KV stood in for (./apiV1-stubs) and DeepL answered by a stubbed fetch.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.DEEPL_API_KEY = "deepl-test:fx";
process.env.CLERK_SECRET_KEY = "sk_test_translation_plan";
delete process.env.ADMIN_EMAILS;

type Stubbed = typeof globalThis & { __users: Record<string, { plan?: string; emails?: string[] }>; __who?: string };
const g = globalThis as Stubbed;
g.__users = {
  user_pro: { plan: "pro", emails: ["pro@example.com"] },
  user_free: { plan: "free", emails: ["free@example.com"] },
  user_starter: { plan: "starter", emails: ["starter@example.com"] },
  user_listener: { plan: "free", emails: ["listener@example.com"] },
};

let deeplCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api-free.deepl.com/")) {
    deeplCalls++;
    return Response.json({ translations: [{ text: "Bonjour à tous.", detected_source_language: "EN" }] });
  }
  return realFetch(input, init);
}) as typeof fetch;

const infos: string[] = [];
const realInfo = console.info;
console.info = (...a: unknown[]) => {
  infos.push(a.map(String).join(" "));
};

let finished = false;
process.on("exit", (code) => {
  if (code === 0 && !finished) {
    console.error("exited before the last check — something never answered");
    process.exitCode = 1;
  }
});

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  realInfo("  ok  " + name);
};

async function main() {
  const { eventStore } = await import("../eventStore");
  const { __clearTranslationGate } = await import("../translationGate");
  const R = await import("../../app/api/translate/route");

  const now = new Date().toISOString();
  for (const [slug, owner] of [["pro-room", "user_pro"], ["free-room", "user_free"], ["starter-room", "user_starter"]] as const) {
    await eventStore.create({
      id: "ev_" + slug, slug, name: slug, ownerUserId: owner, state: "live",
      createdAt: now, updatedAt: now, roles: [],
    } as unknown as Parameters<typeof eventStore.create>[0]);
  }

  async function translate(who: string, room?: string) {
    g.__who = who;
    const res = await R.POST(
      new Request("https://www.neoconference.app/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello everyone.", targetLang: "fr", ...(room !== undefined ? { room } : {}) }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  realInfo("live translation by the meeting owner's plan");

  await t("a Pro owner's meeting: any listener, even on Free, hears it translated", async () => {
    const r = await translate("user_listener", "pro-room");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.translated, "Bonjour à tous.");
  });

  await t("a Free owner's meeting: refused by name, and DeepL is never asked", async () => {
    const before = deeplCalls;
    const r = await translate("user_listener", "free-room");
    assert.equal(r.status, 402);
    assert.equal(r.body.error, "translation_needs_pro");
    assert.match(String(r.body.message), /Pro plan and above/);
    assert.equal(deeplCalls, before);
  });

  await t("a Starter owner's meeting is refused too, even for its owner", async () => {
    assert.equal((await translate("user_starter", "starter-room")).status, 402);
  });

  await t("a room with no meeting behind it has no plan: refused", async () => {
    assert.equal((await translate("user_listener", "nobody-room")).status, 402);
  });

  await t("the owner's plan is kept per room for a few minutes, not looked up per caption", async () => {
    __clearTranslationGate();
    assert.equal((await translate("user_listener", "pro-room")).status, 200);
    // The owner drops to Free mid-meeting: captions keep translating from
    // the kept answer...
    g.__users.user_pro.plan = "free";
    for (let i = 0; i < 3; i++) assert.equal((await translate("user_listener", "pro-room")).status, 200);
    // ...and once it is looked up again, the new plan applies.
    __clearTranslationGate();
    assert.equal((await translate("user_listener", "pro-room")).status, 402);
    g.__users.user_pro.plan = "pro";
    __clearTranslationGate();
  });

  await t("an older app that names no meeting still works, logged once per person", async () => {
    infos.length = 0;
    for (let i = 0; i < 3; i++) assert.equal((await translate("user_listener")).status, 200);
    assert.equal(infos.filter((l) => l.includes("[translate] no room given")).length, 1);
  });

  finished = true;
  realInfo(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
