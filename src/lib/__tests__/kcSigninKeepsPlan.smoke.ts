// Run: npx tsx src/lib/__tests__/kcSigninKeepsPlan.smoke.ts
// A KingsChat sign-in into an existing account must leave the rest of the
// account's public metadata alone. It used to replace all of it with the
// KingsChat details (Clerk's updateUser replaces publicMetadata), so a
// customer who paid for Business lost the plan, its limits and the meeting
// counter on their next KingsChat sign-in, and their room refused people at
// Free's 30 (usareg3, 2026-10-30).
import "./apiV1-stubs/install";
import assert from "node:assert/strict";

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log("  ok  " + name); };

type StubUser = { emails?: string[]; plan?: string; role?: string; metadata?: Record<string, unknown>; externalId?: string };
const g = globalThis as unknown as { __users: Record<string, StubUser> };

// KingsChat's profile endpoint answers with this person.
const realFetch = globalThis.fetch;
let profile: Record<string, unknown> = {};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("kingsch.at/developer/api/profile")) {
    return new Response(JSON.stringify({ profile }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const PAID = {
  plan: "business",
  metadata: {
    planExpiresAt: Date.UTC(2026, 10, 25),
    planId: "business",
    planVersion: 1,
    planLimits: { maxParticipants: 500 },
    meetingsCreated: 3,
  },
};

(async () => {
  const { signInWithKcTokens } = await import("../kc-signin");
  const { getPlanLimitsForUserId } = await import("../plan");
  const signIn = () => signInWithKcTokens({ accessToken: "kc-token", expiresIn: 3600, saveTokens: false });

  await t("a KingsChat-linked account keeps its paid plan, limits and counter after signing in", async () => {
    g.__users = {
      user_paid: {
        emails: ["region@example.com"],
        externalId: "kc:42",
        ...PAID,
        metadata: { ...PAID.metadata, kingschat: { id: "42", username: "old_handle", linkedAt: "2026-08-18T00:00:00.000Z" } },
      },
    };
    profile = { id: "42", username: "usareg3", email: "region@example.com" };
    const res = await signIn();
    assert.equal(res.ok, true, JSON.stringify(res));
    const u = g.__users.user_paid;
    assert.equal(u.plan, "business");
    assert.equal(u.metadata?.planExpiresAt, PAID.metadata.planExpiresAt);
    assert.deepEqual(u.metadata?.planLimits, { maxParticipants: 500 });
    assert.equal(u.metadata?.meetingsCreated, 3);
    assert.deepEqual(u.metadata?.kingschat, { id: "42", username: "usareg3", linkedAt: "2026-08-18T00:00:00.000Z" });
    const { plan, limits } = await getPlanLimitsForUserId("user_paid");
    assert.equal(plan, "business");
    assert.equal(limits.maxParticipants, 500);
  });

  await t("an app role survives a KingsChat sign-in too", async () => {
    g.__users = { user_staff: { emails: ["staff@example.com"], externalId: "kc:7", role: "admin" } };
    profile = { id: "7", username: "staff" };
    assert.equal((await signIn()).ok, true);
    assert.equal(g.__users.user_staff.role, "admin");
    assert.deepEqual(g.__users.user_staff.metadata?.kingschat, { id: "7", username: "staff" });
  });

  await t("linking by email, then signing in again, keeps the plan both times", async () => {
    g.__users = { user_email: { emails: ["buyer@example.com"], ...PAID, metadata: { ...PAID.metadata } } };
    profile = { id: "99", username: "buyer", email: "buyer@example.com" };
    assert.equal((await signIn()).ok, true);
    assert.equal(g.__users.user_email.externalId, "kc:99", "linked on the first sign-in");
    assert.equal(g.__users.user_email.plan, "business");
    assert.equal((await signIn()).ok, true);
    assert.equal(g.__users.user_email.plan, "business", "kept on the second sign-in");
    assert.equal(g.__users.user_email.metadata?.meetingsCreated, 3);
  });

  console.log(`\n${n} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
