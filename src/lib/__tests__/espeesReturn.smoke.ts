// Run: npx tsx src/lib/__tests__/espeesReturn.smoke.ts
//
// The eSPees return and fail routes, through the real handlers with Clerk
// and KV stood in for: eSPees calling the fail URL right after the return
// URL must not undo a paid upgrade; a nonce with something appended still
// finds its checkout; and every request logs which branch it took without
// ever logging the nonce.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.KV_REST_API_URL = "https://kv.stub";
process.env.KV_REST_API_TOKEN = "stub";
process.env.CLERK_SECRET_KEY = "sk_test_espees_return";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";

type Stubbed = typeof globalThis & { __users: Record<string, { plan?: string; emails?: string[]; metadata?: Record<string, unknown> }> };
const g = globalThis as Stubbed;
g.__users = { buyer: { emails: ["buyer@example.com"] }, other: { emails: ["other@example.com"] } };

// Capture the trace lines.
const traced: Record<string, unknown>[] = [];
const info = console.info.bind(console);
console.info = (...args: unknown[]) => {
  const s = String(args[0] ?? "");
  if (s.startsWith('{"tag":"espees-')) traced.push(JSON.parse(s));
  else info(...args);
};

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const { createPendingPayment, generateNonce, readPendingPayment } = await import("../billingStore");
  const { readPayment } = await import("../paymentsStore");
  const ret = await import("../../app/api/billing/espees/return/route");
  const fail = await import("../../app/api/billing/espees/fail/route");

  const hit = async (route: "return" | "fail", query: string) => {
    const res = await (route === "return" ? ret.GET : fail.GET)(new Request(`https://www.neoconference.app/api/billing/espees/${route}${query}`));
    return { status: res.status, location: res.headers.get("location") ?? "" };
  };
  const checkout = async (userId: string, ref: string) => {
    const nonce = generateNonce();
    await createPendingPayment({ nonce, userId, plan: "pro", billingCycle: "monthly", paymentRef: ref });
    return nonce;
  };

  await t("eSPees calling the fail URL after the return URL leaves the upgrade paid", async () => {
    const nonce = await checkout("buyer", "ESP-PAID-1");
    const r = await hit("return", `?nonce=${nonce}`);
    assert.equal(r.status, 303);
    assert.match(r.location, /\/dashboard\?upgraded=pro$/);
    const f = await hit("fail", `?nonce=${nonce}`);
    assert.equal(f.status, 303);
    assert.equal((await readPendingPayment(nonce))?.status, "paid", "the fail hit did not overwrite paid");
    assert.equal((await readPayment("ESP-PAID-1"))?.status, "paid");
    assert.equal(g.__users.buyer.plan, "pro");
    const again = await hit("return", `?nonce=${nonce}`);
    assert.match(again.location, /upgraded=pro/, "a refresh of the return page still shows the upgrade");
    assert.equal(traced.at(-2)?.outcome, "ignored_not_pending");
  });

  await t("a cancelled checkout is failed once; the return URL after it is refused", async () => {
    const nonce = await checkout("other", "ESP-CANCEL-1");
    await hit("fail", `?nonce=${nonce}`);
    assert.equal((await readPendingPayment(nonce))?.status, "failed");
    assert.equal((await readPayment("ESP-CANCEL-1"))?.status, "failed");
    const r = await hit("return", `?nonce=${nonce}`);
    assert.match(r.location, /error=already_resolved/);
    assert.equal(g.__users.other.plan, undefined);
  });

  await t("a nonce with something appended by eSPees still finds its checkout", async () => {
    const nonce = await checkout("other", "ESP-APPENDED-1");
    const r = await hit("return", `?nonce=${nonce}?ref=XYZ&status=success`);
    assert.match(r.location, /upgraded=pro/, r.location);
    assert.equal((await readPayment("ESP-APPENDED-1"))?.status, "paid");
    const line = traced.at(-1)!;
    assert.equal(line.nonce, "trimmed");
    assert.deepEqual(line.queryKeys, ["nonce", "status"]);
    const bad = await hit("return", "?nonce=not-a-nonce");
    assert.match(bad.location, /expired_or_unknown/);
    assert.equal(traced.at(-1)?.nonce, "malformed");
  });

  await t("every request says which branch it took, and never logs the nonce", async () => {
    const outcomes = traced.map((l) => `${l.tag}:${l.outcome}`);
    assert.deepEqual(outcomes.slice(0, 4), ["espees-return:upgraded", "espees-fail:ignored_not_pending", "espees-return:already_paid", "espees-fail:failed"]);
    assert.ok(outcomes.includes("espees-return:already_resolved"));
    const all = JSON.stringify(traced);
    assert.ok(!/[0-9a-f]{48}/.test(all), "no nonce in any trace line");
    assert.equal((traced[0] as { recorded?: boolean }).recorded, true);
    assert.equal((await hit("return", "")).location.endsWith("missing_nonce"), true);
    assert.equal(traced.at(-1)?.outcome, "missing_nonce");
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
