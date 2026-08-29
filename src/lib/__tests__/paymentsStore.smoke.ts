// Run: npx tsx src/lib/__tests__/paymentsStore.smoke.ts
// Roundtrip smoke test for the permanent payments store. Uses the
// in-memory fallback so no KV is required — matches the pattern of
// auditLog.smoke.ts / attendance.smoke.ts.

import assert from "node:assert/strict";
import {
  readPayment,
  listUserPayments,
  recordPayment,
  recordManualGrant,
  assignInvoiceNumber,
  __resetInMemoryPaymentsStore,
} from "../paymentsStore";

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

const NOW = 1_700_000_000_000;

function basePayment(overrides: Partial<Parameters<typeof recordPayment>[0]> = {}) {
  return {
    paymentRef: "PAY-abc-1",
    userId: "user_1",
    plan: "pro" as const,
    billingCycle: "monthly" as const,
    amountEsp: 20,
    periodStart: NOW,
    periodEnd: NOW + 30 * 24 * 60 * 60 * 1000,
    paidAt: NOW,
    ...overrides,
  };
}

async function main() {
  console.log("payments store");

  await t("readPayment returns null for unknown ref", async () => {
    __resetInMemoryPaymentsStore();
    assert.equal(await readPayment("does-not-exist"), null);
  });

  await t("recordPayment creates + read returns it", async () => {
    __resetInMemoryPaymentsStore();
    const result = await recordPayment(basePayment());
    assert.equal(result.created, true);
    assert.equal(result.record.paymentRef, "PAY-abc-1");
    assert.equal(result.record.plan, "pro");
    assert.equal(result.record.status, "paid");
    // Default source is the unverified redirect grant.
    assert.equal(result.record.source, "espees-redirect-unverified");
    const back = await readPayment("PAY-abc-1");
    assert.deepEqual(back, result.record);
  });

  await t("recordPayment is idempotent on paymentRef", async () => {
    __resetInMemoryPaymentsStore();
    const first = await recordPayment(basePayment());
    // Same ref, different data — must NOT overwrite.
    const second = await recordPayment(basePayment({ amountEsp: 999 }));
    assert.equal(second.created, false);
    assert.equal(second.record.amountEsp, first.record.amountEsp);
    // User list must not double-append.
    const list = await listUserPayments("user_1");
    assert.equal(list.length, 1);
  });

  await t("listUserPayments returns newest first", async () => {
    __resetInMemoryPaymentsStore();
    await recordPayment(basePayment({ paymentRef: "P1", paidAt: NOW }));
    await recordPayment(
      basePayment({ paymentRef: "P2", paidAt: NOW + 1000 }),
    );
    await recordPayment(
      basePayment({ paymentRef: "P3", paidAt: NOW + 2000 }),
    );
    const list = await listUserPayments("user_1");
    assert.deepEqual(list.map((r) => r.paymentRef), ["P3", "P2", "P1"]);
  });

  await t("listUserPayments respects limit", async () => {
    __resetInMemoryPaymentsStore();
    for (let i = 0; i < 5; i++) {
      await recordPayment(
        basePayment({ paymentRef: `P${i}`, paidAt: NOW + i }),
      );
    }
    const list = await listUserPayments("user_1", 2);
    assert.equal(list.length, 2);
    assert.equal(list[0].paymentRef, "P4");
    assert.equal(list[1].paymentRef, "P3");
  });

  await t("listUserPayments scopes per user", async () => {
    __resetInMemoryPaymentsStore();
    await recordPayment(basePayment({ paymentRef: "A", userId: "user_1" }));
    await recordPayment(basePayment({ paymentRef: "B", userId: "user_2" }));
    const a = await listUserPayments("user_1");
    const b = await listUserPayments("user_2");
    assert.deepEqual(a.map((r) => r.paymentRef), ["A"]);
    assert.deepEqual(b.map((r) => r.paymentRef), ["B"]);
  });

  await t("recordManualGrant stamps source=manual", async () => {
    __resetInMemoryPaymentsStore();
    const result = await recordManualGrant({
      paymentRef: "MANUAL-1",
      userId: "user_ent",
      plan: "enterprise",
      billingCycle: "annual",
      amountEsp: 5000,
      periodStart: NOW,
      periodEnd: NOW + 365 * 24 * 60 * 60 * 1000,
      paidAt: NOW,
    });
    assert.equal(result.created, true);
    assert.equal(result.record.source, "manual");
    assert.equal(result.record.plan, "enterprise");
  });

  await t("recordPayment throws on empty paymentRef", async () => {
    __resetInMemoryPaymentsStore();
    await assert.rejects(
      () => recordPayment(basePayment({ paymentRef: "" })),
      /paymentRef/,
    );
  });

  await t("assignInvoiceNumber assigns then freezes", async () => {
    __resetInMemoryPaymentsStore();
    await recordPayment(basePayment({ paymentRef: "INV-1" }));
    const first = await assignInvoiceNumber("INV-1");
    assert.equal(first.assigned, true);
    assert.match(first.number, /^NEO-\d{6}$/);
    // Second call is idempotent — same number, does not bump.
    const second = await assignInvoiceNumber("INV-1");
    assert.equal(second.assigned, false);
    assert.equal(second.number, first.number);
    // Record is now stamped.
    const back = await readPayment("INV-1");
    assert.equal(back?.invoiceNumber, first.number);
  });

  await t("assignInvoiceNumber increments across payments", async () => {
    __resetInMemoryPaymentsStore();
    await recordPayment(basePayment({ paymentRef: "N1" }));
    await recordPayment(basePayment({ paymentRef: "N2" }));
    const a = await assignInvoiceNumber("N1");
    const b = await assignInvoiceNumber("N2");
    assert.notEqual(a.number, b.number);
    // Sequential.
    const aNum = parseInt(a.number.replace(/^NEO-/, ""), 10);
    const bNum = parseInt(b.number.replace(/^NEO-/, ""), 10);
    assert.equal(bNum, aNum + 1);
  });

  await t("assignInvoiceNumber rejects unknown paymentRef", async () => {
    __resetInMemoryPaymentsStore();
    await assert.rejects(
      () => assignInvoiceNumber("does-not-exist"),
      /payment_not_found/,
    );
  });

  console.log("\n" + n + " passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
