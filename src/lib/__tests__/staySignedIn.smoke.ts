// Run: npx tsx src/lib/__tests__/staySignedIn.smoke.ts
//
// Signed in until you sign out (owner, 2026-10-19). The website's device
// session was bound to the browser's full user agent and language list, so
// every Chrome update (its version is in the user agent) signed people out
// with "Your session ended". Driven through the real session store and the
// real create-session route, with KV and Clerk stood in for (./apiV1-stubs).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "./apiV1-stubs/install";

process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "t";
(globalThis as { __kvTtl?: boolean }).__kvTtl = true;

type Stubbed = typeof globalThis & { __users: Record<string, { emails?: string[] }>; __who?: string };
const g = globalThis as Stubbed;
g.__users = { user_a: { emails: ["a@example.com"] } };

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
  console.log("  ok  " + name);
};

const chrome = (v: number) =>
  `Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Mobile Safari/537.36`;
const firefoxWindows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";

async function main() {
  const S = await import("../sessionStore");
  const { kv } = await import("../kv");
  const ip = "203.0.113.9";
  const fp = (ua: string) => S.generateDeviceFingerprint(ua);
  const make = async (ua: string) =>
    S.createSession("user_a", { ip, fingerprint: await fp(ua), userAgent: ua });

  await t("a Chrome update keeps you signed in", async () => {
    const token = await make(chrome(152));
    assert.equal((await S.validateSession(token, ip, await fp(chrome(153)), chrome(153))).status, "valid");
    assert.equal((await S.validateSession(token, ip, await fp(chrome(160)), chrome(160))).status, "valid");
  });

  await t("so do a new language list and a new network", async () => {
    // The language list is no longer part of the device at all.
    const token = await make(chrome(152));
    assert.equal((await S.validateSession(token, "198.51.100.4", await fp(chrome(152)), chrome(152))).status, "valid");
  });

  await t("the cookie in another kind of browser or device is still refused, and that session ends", async () => {
    const token = await make(chrome(152));
    assert.equal((await S.validateSession(token, ip, await fp(firefoxWindows), firefoxWindows)).status, "invalid");
    assert.equal((await S.validateSession(token, ip, await fp(chrome(152)), chrome(152))).status, "invalid");
  });

  await t("a session made before this change carries over after a Chrome update, re-keyed", async () => {
    // Written as the old code did: full user agent and language list.
    const token = "legacy-token-1";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const legacyFp = createHash("sha256").update(`${chrome(150)}|en-GB,en;q=0.9`).digest("hex");
    const created = Date.now() - 40 * 86_400_000;
    await kv.set(`neo:session:${tokenHash}`, {
      userId: "user_a",
      fingerprint: legacyFp,
      userAgent: chrome(150),
      ip,
      ipLastSeen: ip,
      createdAt: created,
      lastActivityAt: created,
    });
    await kv.set(`neo:session-device:user_a:${legacyFp}`, tokenHash);
    const now = await fp(chrome(153));
    assert.equal((await S.validateSession(token, ip, now, chrome(153))).status, "valid");
    const rec = (await kv.get(`neo:session:${tokenHash}`)) as { fingerprint: string; userAgent: string };
    assert.equal(rec.fingerprint, now);
    assert.equal(rec.userAgent, chrome(153));
    assert.equal(await kv.get(`neo:session-device:user_a:${legacyFp}`), null);
    assert.equal(await kv.get(`neo:session-device:user_a:${now}`), tokenHash);
    // And on the next visit, as any session.
    assert.equal((await S.validateSession(token, ip, now, chrome(153))).status, "valid");
  });

  await t("an old session from another kind of browser does not carry over", async () => {
    const token = "legacy-token-2";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const legacyFp = createHash("sha256").update(`${firefoxWindows}|en`).digest("hex");
    await kv.set(`neo:session:${tokenHash}`, {
      userId: "user_a",
      fingerprint: legacyFp,
      userAgent: firefoxWindows,
      ip,
      ipLastSeen: ip,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    assert.equal((await S.validateSession(token, ip, await fp(chrome(153)), chrome(153))).status, "invalid");
  });

  await t("no one-year limit: a session in use for two years is still valid", async () => {
    const token = await make(chrome(152));
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const rec = (await kv.get(`neo:session:${tokenHash}`)) as Record<string, unknown>;
    await kv.set(`neo:session:${tokenHash}`, { ...rec, createdAt: Date.now() - 2 * 365 * 86_400_000 });
    assert.equal((await S.validateSession(token, ip, await fp(chrome(152)), chrome(152))).status, "valid");
  });

  await t("away for a year still signed in: the session lasts 400 days from the last visit", async () => {
    assert.equal(S.SESSION_TTL_SECONDS, 400 * 86_400);
    const token = await make(chrome(152));
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const left = await kv.pttl(`neo:session:${tokenHash}`);
    assert.ok(left > 399 * 86_400_000, String(left));
  });

  await t("signing out still ends it, on this device and everywhere", async () => {
    const one = await make(chrome(152));
    await S.logout("user_a", one, "device");
    assert.equal((await S.validateSession(one, ip, await fp(chrome(152)), chrome(152))).status, "invalid");
    const two = await make(chrome(153));
    await S.logout("user_a", null, "all");
    assert.equal((await S.validateSession(two, ip, await fp(chrome(153)), chrome(153))).status, "invalid");
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
