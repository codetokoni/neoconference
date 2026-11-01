// Run: npx tsx src/lib/__tests__/enterpriseForAll.smoke.ts
// Enterprise for everyone until a date (ENTERPRISE_FOR_ALL_UNTIL): every
// signed-in account, new or old, free or paid, counts as Enterprise with
// Enterprise's limits until then, and nothing is written to any account, so
// each goes back to its own plan when the date passes. Asked for on
// 2026-11-01: "make everybody that logins or register to enterprise plan till
// year ends".
import "./apiV1-stubs/install";
import assert from "node:assert/strict";

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log("  ok  " + name); };

type StubUser = { emails?: string[]; plan?: string; metadata?: Record<string, unknown> };
const g = globalThis as unknown as { __users: Record<string, StubUser>; __who?: string };

const DAY = 24 * 60 * 60 * 1000;
const FUTURE = new Date(Date.now() + 30 * DAY).toISOString();
const PAST = new Date(Date.now() - DAY).toISOString();

const users = (): Record<string, StubUser> => ({
  // A new account: nothing stored at all.
  user_new: { emails: ["new@example.com"] },
  // A Free account at its lifetime meeting cap.
  user_free: { emails: ["free@example.com"], plan: "free", metadata: { meetingsCreated: 99 } },
  // A paying Starter customer.
  user_starter: {
    emails: ["starter@example.com"],
    plan: "starter",
    metadata: { planExpiresAt: Date.now() + 60 * DAY, planLimits: { maxParticipants: 50 } },
  },
  // An Enterprise subscription on custom terms bigger than Enterprise's defaults.
  user_custom: {
    emails: ["school@example.com"],
    plan: "enterprise",
    metadata: { planExpiresAt: Date.now() + 300 * DAY, planLimits: { maxParticipants: 5000 } },
  },
});

(async () => {
  const plan = await import("../plan");
  const { getPlanLimits } = await import("../planLimits");
  const enterprise = getPlanLimits("enterprise");

  const set = (v: string | undefined) => {
    if (v === undefined) delete process.env.ENTERPRISE_FOR_ALL_UNTIL;
    else process.env.ENTERPRISE_FOR_ALL_UNTIL = v;
  };

  await t("until the date: every account is Enterprise, with Enterprise's limits", async () => {
    set(FUTURE);
    g.__users = users();
    for (const id of ["user_new", "user_free", "user_starter"]) {
      assert.equal(await plan.getPlanForUserId(id), "enterprise", id);
      const { plan: p, limits } = await plan.getPlanLimitsForUserId(id);
      assert.equal(p, "enterprise", id);
      assert.equal(limits.maxParticipants, enterprise.maxParticipants, id);
      assert.equal(limits.meetingMinutes, enterprise.meetingMinutes, id);
      g.__who = id;
      assert.equal(await plan.getCurrentPlan(), "enterprise", id);
    }
  });

  await t("until the date: a Free account at its meeting cap is not capped", async () => {
    set(FUTURE);
    g.__users = users();
    const cap = await plan.checkLifetimeCap("user_free");
    assert.equal(cap.blocked, false, JSON.stringify(cap));
  });

  await t("an Enterprise subscription keeps the bigger limits it bought", async () => {
    set(FUTURE);
    g.__users = users();
    const { plan: p, limits } = await plan.getPlanLimitsForUserId("user_custom");
    assert.equal(p, "enterprise");
    assert.equal(limits.maxParticipants, 5000);
  });

  await t("nothing is written to any account", async () => {
    set(FUTURE);
    g.__users = users();
    const before = JSON.stringify(g.__users);
    for (const id of Object.keys(g.__users)) {
      await plan.getPlanForUserId(id);
      await plan.getPlanLimitsForUserId(id);
      g.__who = id;
      await plan.getCurrentPlan();
    }
    assert.equal(JSON.stringify(g.__users), before);
  });

  await t("after the date, unset or unreadable: each account has its own plan again", async () => {
    for (const v of [PAST, undefined, "", "next year"]) {
      set(v);
      g.__users = users();
      assert.equal(plan.enterpriseForAllUntil(), null, String(v));
      assert.equal(await plan.getPlanForUserId("user_new"), "free", String(v));
      assert.equal(await plan.getPlanForUserId("user_starter"), "starter", String(v));
      assert.equal((await plan.getPlanLimitsForUserId("user_starter")).limits.maxParticipants, 50, String(v));
      assert.equal((await plan.checkLifetimeCap("user_free")).blocked, true, String(v));
    }
  });

  await t("the end is the moment given", async () => {
    set("2027-01-01T00:00:00+01:00");
    const end = Date.parse("2026-12-31T23:00:00Z");
    assert.equal(plan.enterpriseForAllUntil(end - 1), end);
    assert.equal(plan.enterpriseForAllUntil(end), null);
  });

  set(undefined);
  console.log(`\nenterpriseForAll: ${n} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
