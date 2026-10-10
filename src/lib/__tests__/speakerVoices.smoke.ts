// Run: npx tsx src/lib/__tests__/speakerVoices.smoke.ts
//
// Meeting translation in the speaker's own (cloned) voice, through the real
// /api/admin/voices and /api/voice/speak routes, with KV and Clerk stood in
// for (./apiV1-stubs) and Cartesia answered by a stubbed fetch. Checks the
// consent gate, the authenticator step, one shared clip per sentence, the
// daily cap, the languages, and that removing a voice removes it at Cartesia.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  CLERK_SECRET_KEY: "sk_test_voices",
  PLATFORM_OWNER_EMAILS: "owner@example.com",
  CARTESIA_API_KEY: "sk_car_test",
  VOICE_ROOM_DAILY_CHARS: "200",
});
delete process.env.ADMIN_EMAILS;

type Stubbed = typeof globalThis & { __users: Record<string, { emails?: string[]; createdAt?: number }>; __who?: string };
const g = globalThis as Stubbed;
g.__users = {
  user_owner: { emails: ["owner@example.com"], createdAt: 1 },
  user_pastor: { emails: ["pastor@example.com"], createdAt: 1 },
  user_listener: { emails: ["listener@example.com"], createdAt: 1 },
};

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
};

// Cartesia stand-in.
const cartesia: Array<{ path: string; method: string; body?: unknown }> = [];
let ttsFails = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.cartesia.ai/")) return realFetch(input, init);
  const path = url.slice("https://api.cartesia.ai".length);
  const h = new Headers(init?.headers);
  assert.equal(h.get("authorization"), "Bearer sk_car_test");
  assert.equal(h.get("cartesia-version"), "2026-08-14");
  if (path === "/voices/clone") {
    const form = init?.body as FormData;
    cartesia.push({ path, method: "POST", body: { name: form.get("name"), language: form.get("language"), clip: (form.get("clip") as Blob).size } });
    return Response.json({ id: `voice_${cartesia.length}` });
  }
  if (path === "/tts/bytes") {
    const body = JSON.parse(String(init?.body));
    cartesia.push({ path, method: "POST", body });
    if (ttsFails) return new Response("upstream", { status: 500 });
    return new Response(new Uint8Array([0x49, 0x44, 0x33, body.transcript.length]), { headers: { "content-type": "audio/mpeg" } });
  }
  if (path.startsWith("/voices/") && init?.method === "DELETE") {
    cartesia.push({ path, method: "DELETE" });
    return new Response(null, { status: 204 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const mfa = await import("../admin/mfa");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    voices: await import("../../app/api/admin/voices/route"),
    speak: await import("../../app/api/voice/speak/route"),
  };
  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};

  async function call(
    who: string | null,
    handler: (req: Request) => Promise<Response>,
    opts: { method?: string; body?: unknown; form?: FormData; query?: string } = {},
  ) {
    g.__who = who ?? undefined;
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (who && jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new Request(`https://www.neoconference.app/api/x${opts.query ?? ""}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      }),
    );
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m && who) jar[who] = decodeURIComponent(m[1]);
    const type = res.headers.get("content-type") ?? "";
    if (type.startsWith("audio/")) return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()), body: {} as Record<string, unknown> };
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { text };
    }
    return { status: res.status, headers: res.headers, bytes: null as Uint8Array | null, body };
  }
  const code = (who: string) => mfa.totpAt(mfa.base32Decode(secrets[who]), mfa.currentStep());
  async function signInAdmin(who: string) {
    const e = await call(who, R.enroll.POST, { method: "POST" });
    secrets[who] = e.body.secret as string;
    tick();
    await call(who, R.confirm.POST, { method: "POST", body: { code: code(who) } });
  }
  async function stepUp(who: string) {
    tick();
    const v = await call(who, R.verify.POST, { method: "POST", body: { code: code(who) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }
  function voiceForm(over: Record<string, string | null> = {}) {
    const f = new FormData();
    const fields: Record<string, string | null> = {
      userId: "user_pastor",
      name: "Pastor Chris",
      sampleLanguage: "en",
      consentBy: "Chris O.",
      consentAt: "2026-10-10",
      consentStatement: "I agree to my voice being used for meeting translations.",
      ...over,
    };
    for (const [k, v] of Object.entries(fields)) if (v !== null) f.append(k, v);
    if (over.clip !== null) f.append("clip", new Blob([new Uint8Array(2048)], { type: "audio/wav" }), "sample.wav");
    return f;
  }
  async function speak(who: string | null, body: Record<string, unknown>) {
    return call(who, R.speak.POST, { method: "POST", body });
  }
  const sentence = (text: string, lang = "fr", identity = "user_pastor#abc123") => ({ room: "sunday-service", identity, lang, text });

  console.log("speaker voices: admin");
  await signInAdmin("user_owner");
  // Confirming the authenticator counts as a fresh code for 10 minutes; let it lapse.
  tick(11 * 60_000);

  await t("making a voice needs a fresh authenticator code", async () => {
    const r = await call("user_owner", R.voices.POST, { method: "POST", form: voiceForm() });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "step_up_required");
    assert.equal(cartesia.length, 0);
  });

  await t("no voice without the recorded consent", async () => {
    await stepUp("user_owner");
    const r = await call("user_owner", R.voices.POST, { method: "POST", form: voiceForm({ consentBy: null, consentStatement: null }) });
    assert.equal(r.status, 400);
    assert.match(String(r.body.message), /who gave consent.*consent statement/);
    assert.equal(cartesia.length, 0);
  });

  await t("someone who is not an admin cannot see or make voices", async () => {
    const r = await call("user_listener", R.voices.GET);
    assert.ok(r.status === 401 || r.status === 403, String(r.status));
  });

  await t("with consent: the voice is made at Cartesia and listed with its consent", async () => {
    const r = await call("user_owner", R.voices.POST, { method: "POST", form: voiceForm() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(cartesia[0], { path: "/voices/clone", method: "POST", body: { name: "Pastor Chris", language: "en", clip: 2048 } });
    const list = await call("user_owner", R.voices.GET);
    const v = (list.body.voices as Array<{ userId: string; voiceId: string; enabled: boolean; consent: { by: string } }>)[0];
    assert.deepEqual([v.userId, v.voiceId, v.enabled, v.consent.by], ["user_pastor", "voice_1", true, "Chris O."]);
    assert.equal(list.body.configured, true);
  });

  console.log("speaker voices: in a meeting");
  await t("speaking needs a signed-in listener", async () => {
    assert.equal((await speak(null, sentence("Bonjour à tous."))).status, 401);
  });

  await t("the speaker's sentence comes back as MP3 in their voice", async () => {
    const r = await speak("user_listener", sentence("Bonjour à tous."));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-voice-status"), "made");
    assert.ok(r.bytes && r.bytes[0] === 0x49);
    const tts = cartesia.at(-1)!;
    assert.equal(tts.path, "/tts/bytes");
    assert.deepEqual(
      [(tts.body as { voice: { id: string } }).voice.id, (tts.body as { language: string }).language, (tts.body as { transcript: string }).transcript],
      ["voice_1", "fr", "Bonjour à tous."],
    );
  });

  await t("every listener of that sentence shares the one clip", async () => {
    const before = cartesia.length;
    for (let i = 0; i < 4; i++) {
      const r = await speak("user_listener", sentence("Bonjour à tous.", "fr", "user_pastor#otherdevice"));
      assert.equal(r.headers.get("x-voice-status"), "cached");
    }
    assert.equal(cartesia.length, before);
  });

  await t("a speaker without a voice: 204 no_voice, no Cartesia call", async () => {
    const before = cartesia.length;
    const r = await speak("user_listener", sentence("Salut.", "fr", "user_listener#x"));
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("x-voice-status"), "no_voice");
    assert.equal(cartesia.length, before);
  });

  await t("Swahili is not offered: 204 language", async () => {
    const r = await speak("user_listener", sentence("Habari zenu.", "sw"));
    assert.equal(r.headers.get("x-voice-status"), "language");
  });

  await t("Cartesia failing: 204 failed (the page uses the computer voice)", async () => {
    ttsFails = true;
    const r = await speak("user_listener", sentence("Une phrase qui échoue."));
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("x-voice-status"), "failed");
    ttsFails = false;
  });

  await t("past the meeting's daily cap: 204 capped, no Cartesia call", async () => {
    // The cap is 200 characters; "Bonjour à tous." used 15.
    const long = "x".repeat(180);
    assert.equal((await speak("user_listener", sentence(long))).status, 200);
    const before = cartesia.length;
    const r = await speak("user_listener", sentence("Encore une phrase."));
    assert.equal(r.headers.get("x-voice-status"), "capped");
    assert.equal(cartesia.length, before);
    // Another meeting has its own cap.
    const other = await speak("user_listener", { ...sentence("Encore une phrase."), room: "other-room" });
    assert.equal(other.status, 200);
  });

  await t("switched off: 204 no_voice", async () => {
    await stepUp("user_owner");
    const off = await call("user_owner", R.voices.PATCH, { method: "PATCH", body: { userId: "user_pastor", enabled: false } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const r = await speak("user_listener", { ...sentence("Nouvelle phrase."), room: "third-room" });
    assert.equal(r.headers.get("x-voice-status"), "no_voice");
  });

  await t("deleted: removed at Cartesia and here", async () => {
    await stepUp("user_owner");
    const del = await call("user_owner", R.voices.DELETE, { method: "DELETE", query: "?userId=user_pastor" });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.removedAtCartesia, true);
    assert.deepEqual(cartesia.at(-1), { path: "/voices/voice_1", method: "DELETE" });
    assert.deepEqual((await call("user_owner", R.voices.GET)).body.voices, []);
  });

  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
