// Run: npx tsx src/lib/__tests__/micLockFailure.smoke.ts
//
// "Lock mics" when LiveKit does not answer (/api/livekit/mic-lock). The
// toolbar's label follows the state the server confirmed, so a press that
// took no effect must not be confirmed: the lock is put back, the caller gets
// a sentence to show, and a LiveKit that never answers is given up on rather
// than leaving the button busy for ever. A room nobody has joined yet is not
// a failure: the lock waits for the first token.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_mic_lock_failure";
process.env.PLATFORM_OWNER_EMAILS = "platform@example.com";
process.env.ADMIN_EMAILS = "";
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.NEXT_PUBLIC_LIVEKIT_URL = "wss://lk.test";
process.env.LIVEKIT_API_KEY = "lk_key";
process.env.LIVEKIT_API_SECRET = "lk_secret_that_is_long_enough_for_hs256";

const g = globalThis as typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[] }>;
  __who?: string;
  __lkParticipants?: Record<string, unknown[]>;
  __lkHang?: boolean;
};
g.__users = { user_owner: { plan: "pro", emails: ["owner@example.com"] } };

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

async function main() {
  const { NextRequest } = await import("next/server");
  const { eventStore } = await import("../eventStore");
  const M = await import("../micLock");
  const R = await import("../../app/api/livekit/mic-lock/route");
  const now = new Date().toISOString();
  await eventStore.create({
    id: "ev_fail", slug: "fail-room", name: "Fail", ownerUserId: "user_owner", ownerEmail: "owner@example.com",
    state: "live", visibility: "unlisted", livekitRoom: "fail-room", waitingRoomEnabled: false, waitForHost: false,
    createdAt: now, updatedAt: now, roles: [],
  } as unknown as Parameters<typeof eventStore.create>[0]);

  const press = async (action: "lock" | "unlock") => {
    g.__who = "user_owner";
    const res = await R.POST(
      new NextRequest("https://neolinguameet.com/api/livekit/mic-lock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "fail-room", action }),
      }),
    );
    return { status: res.status, body: (await res.json()) as { locked?: boolean; message?: string; error?: string } };
  };

  await t("LiveKit unreachable: Lock mics is refused, not confirmed, and the lock stays off", async () => {
    g.__lkParticipants = undefined; // listParticipants throws
    const r = await press("lock");
    assert.equal(r.status, 502);
    assert.equal(r.body.locked, false);
    assert.equal(r.body.message, "Couldn't lock the microphones. The meeting server didn't answer. Try again.");
    assert.equal((await M.getMicLock("ev_fail")).locked, false);
  });

  await t("the other way too: a failed Unlock mics keeps everyone locked", async () => {
    await M.saveMicLock("ev_fail", { locked: true, allowed: [] });
    const r = await press("unlock");
    assert.equal(r.status, 502);
    assert.equal(r.body.locked, true);
    assert.match(String(r.body.message), /^Couldn't unlock the microphones\./);
    assert.equal((await M.getMicLock("ev_fail")).locked, true);
    await M.saveMicLock("ev_fail", { locked: false, allowed: [] });
  });

  await t("LiveKit that never answers is given up on, and nothing changes", async () => {
    g.__lkHang = true;
    const started = Date.now();
    const r = await press("lock");
    const took = Date.now() - started;
    g.__lkHang = false;
    assert.equal(r.status, 502);
    assert.ok(took < 12_000, `answered after ${took}ms`);
    assert.equal((await M.getMicLock("ev_fail")).locked, false);
  });

  await t("nobody in the room yet is not a failure: the lock waits for the first token", async () => {
    g.__lkParticipants = { "fail-room": [] };
    const r = await press("lock");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.locked, true);
    assert.equal((await M.getMicLock("ev_fail")).locked, true);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
