// Run: npx tsx src/lib/__tests__/adminMfaReplay.smoke.ts
//
// An accepted admin two-factor code is accepted once, even when the same code
// arrives many times at once: the checks and the write to the MFA record
// used to be separate KV calls, so concurrent requests all read the old
// record and all passed. KV is the in-memory stand-in (./apiV1-stubs), whose
// calls yield between each other like the real one's round trips do.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_admin_mfa_replay";

type Stubbed = typeof globalThis & { __kvStore: Map<string, unknown> };
const g = globalThis as Stubbed;

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
};

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

const ATTEMPTS = 20;

async function main() {
  const mfa = await import("../admin/mfa");
  const recKey = (uid: string) => `neo:admin:mfa:${uid}`;
  const failKey = (uid: string) => `neo:admin:mfa:fail:${uid}`;
  const stored = (uid: string) => {
    const raw = g.__kvStore.get(recKey(uid));
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as { secret: string; enabledAt: number; recovery: string[]; lastStep: number };
  };
  const tally = (results: string[]) => results.reduce<Record<string, number>>((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {});

  async function enroll(uid: string) {
    const { secret } = await mfa.startEnrollment(uid, `${uid}@example.com`);
    const key = mfa.base32Decode(secret);
    const codes = await mfa.confirmEnrollment(uid, mfa.totpAt(key, mfa.currentStep()));
    assert.ok(codes, "enrolled");
    return { key, codes };
  }

  console.log("one code, many requests");
  await t(`${ATTEMPTS} concurrent requests with the same authenticator code: exactly one is accepted`, async () => {
    const { key } = await enroll("user_a");
    const before = stored("user_a");
    tick();
    const step = mfa.currentStep();
    const code = mfa.totpAt(key, step);
    const results = await Promise.all(Array.from({ length: ATTEMPTS }, () => mfa.verifyAdminCode("user_a", code)));
    assert.equal(results.filter((r) => r === "ok").length, 1, JSON.stringify(tally(results)));
    assert.ok(results.every((r) => r === "ok" || r === "invalid" || r === "locked"), JSON.stringify(tally(results)));
    const after = stored("user_a");
    assert.equal(after.lastStep, step);
    assert.equal(after.secret, before.secret, "the record keeps its secret");
    assert.equal(after.enabledAt, before.enabledAt);
    assert.deepEqual(after.recovery, before.recovery);
    g.__kvStore.delete(failKey("user_a"));
    assert.equal(await mfa.verifyAdminCode("user_a", code), "invalid", "and it stays used");
  });

  await t(`${ATTEMPTS} concurrent requests with the same recovery code: exactly one is accepted`, async () => {
    const { codes } = await enroll("user_b");
    const results = await Promise.all(Array.from({ length: ATTEMPTS }, () => mfa.verifyAdminCode("user_b", codes[3])));
    assert.equal(results.filter((r) => r === "recovery").length, 1, JSON.stringify(tally(results)));
    assert.ok(results.every((r) => r === "recovery" || r === "invalid" || r === "locked"), JSON.stringify(tally(results)));
    assert.equal(stored("user_b").recovery.length, 9);
    assert.equal((await mfa.mfaStatus("user_b")).recoveryLeft, 9);
    g.__kvStore.delete(failKey("user_b"));
    assert.equal(await mfa.verifyAdminCode("user_b", codes[3]), "invalid", "and it stays used");
    assert.equal(await mfa.verifyAdminCode("user_b", ` ${codes[4].toUpperCase()} `), "recovery", "the others still work, as typed before");
  });

  console.log("writes that cross");
  await t("a code used while recovery codes are regenerated does not bring the old codes back", async () => {
    const { codes: old } = await enroll("user_c");
    const [used, fresh] = await Promise.all([mfa.verifyAdminCode("user_c", old[0]), mfa.regenerateRecoveryCodes("user_c")]);
    assert.ok(fresh && fresh.length === 10);
    assert.ok(used === "recovery" || used === "invalid", used);
    assert.equal(await mfa.verifyAdminCode("user_c", old[1]), "invalid", "an old code is gone");
    assert.equal(await mfa.verifyAdminCode("user_c", fresh[0]), "recovery", "a new code works");
    assert.equal((await mfa.mfaStatus("user_c")).recoveryLeft, 9);
  });

  await t("an authenticator code used while recovery codes are regenerated stays used", async () => {
    const { key } = await enroll("user_d");
    tick();
    const code = mfa.totpAt(key, mfa.currentStep());
    const [ok, fresh] = await Promise.all([mfa.verifyAdminCode("user_d", code), mfa.regenerateRecoveryCodes("user_d")]);
    assert.equal(ok, "ok");
    assert.ok(fresh);
    assert.equal(stored("user_d").lastStep, mfa.currentStep(), "lastStep was not rolled back");
    assert.equal(await mfa.verifyAdminCode("user_d", code), "invalid");
    assert.equal(await mfa.verifyAdminCode("user_d", fresh[0]), "recovery");
  });

  console.log("unchanged");
  await t("a record written before this change verifies, and wrong codes still lock after five", async () => {
    const { key } = await enroll("user_e");
    // As the old code stored it: a JSON string, fields in this order.
    const r = stored("user_e");
    g.__kvStore.set(recKey("user_e"), JSON.stringify({ secret: r.secret, enabledAt: r.enabledAt, recovery: r.recovery, lastStep: r.lastStep }));
    tick();
    assert.equal(await mfa.verifyAdminCode("user_e", mfa.totpAt(key, mfa.currentStep())), "ok");
    const wrong: string[] = [];
    for (let i = 0; i < 5; i++) wrong.push(await mfa.verifyAdminCode("user_e", "000000"));
    assert.deepEqual(wrong, ["invalid", "invalid", "invalid", "invalid", "locked"]);
    tick();
    assert.equal(await mfa.verifyAdminCode("user_e", mfa.totpAt(key, mfa.currentStep())), "locked");
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
