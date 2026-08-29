// scripts/backfill-ror-media-enterprise.ts
//
// One-shot backfill for the ROR Media Control Room Enterprise grant that
// was made by hand in Clerk on 29 Aug 2026. Task 1 (PR #109) added the
// paymentsStore but historical grants predate it, so /dashboard/billing
// would otherwise show a plan with no payment history behind it. This
// script writes the missing PaymentRecord using the operator-supplied
// amount and reference.
//
// Refuses to write without `--commit`. First run prints exactly what it
// would do; verify, then re-run with `--commit`.
//
// Required env:
//   CLERK_SECRET_KEY       — to resolve the target's userId from email
//   KV_REST_API_URL        — production KV (paymentsStore lives here)
//   KV_REST_API_TOKEN
//
// Optional env (defaults are the values agreed in the handoff §8 Q3):
//   BACKFILL_EMAIL         (default: rhapsodybrandsandcomms@gmail.com)
//   BACKFILL_PAYMENT_REF   (default: MANUAL-ROR-2026-08)
//   BACKFILL_AMOUNT_ESP    (default: 1000)
//   BACKFILL_CYCLE         (default: monthly — 30-day gap between grant
//                           and expiry per the handoff. Pass "annual"
//                           only if the grant was actually sold as annual
//                           and the current Clerk expiry is a bug.)
//   BACKFILL_PAID_AT_ISO   (default: 2026-08-29T00:00:00Z)
//   BACKFILL_PERIOD_END_MS (default: 1790636399000, from the handoff)
//
// Runs via tsx from the repo root:
//   npx tsx scripts/backfill-ror-media-enterprise.ts            # dry run
//   npx tsx scripts/backfill-ror-media-enterprise.ts --commit   # write
//
// Idempotent — recordPayment refuses to overwrite an existing record
// with the same paymentRef, so a second run is a safe no-op.

import { createClerkClient } from "@clerk/nextjs/server";
import {
  readPayment,
  recordManualGrant,
  __resetInMemoryPaymentsStore,
} from "../src/lib/paymentsStore";
import { appendAuditEntry } from "../src/lib/auditLog";
import type { BillingCycle } from "../src/lib/espees";

const COMMIT = process.argv.includes("--commit");

const email = (process.env.BACKFILL_EMAIL || "rhapsodybrandsandcomms@gmail.com")
  .trim()
  .toLowerCase();
const paymentRef = (process.env.BACKFILL_PAYMENT_REF || "MANUAL-ROR-2026-08").trim();
const amountEsp = Number(process.env.BACKFILL_AMOUNT_ESP ?? "1000");
const rawCycle = (process.env.BACKFILL_CYCLE || "monthly").trim() as BillingCycle;
const paidAtIso = (process.env.BACKFILL_PAID_AT_ISO || "2026-08-29T00:00:00Z").trim();
const paidAt = Date.parse(paidAtIso);
const periodEnd = Number(process.env.BACKFILL_PERIOD_END_MS ?? "1790636399000");

function bail(msg: string): never {
  console.error("Error: " + msg);
  process.exit(1);
}

if (rawCycle !== "monthly" && rawCycle !== "annual") {
  bail(`BACKFILL_CYCLE must be "monthly" or "annual", got "${rawCycle}"`);
}
if (!Number.isFinite(amountEsp) || amountEsp <= 0) {
  bail(`BACKFILL_AMOUNT_ESP must be a positive number, got "${process.env.BACKFILL_AMOUNT_ESP}"`);
}
if (!Number.isFinite(paidAt)) {
  bail(`BACKFILL_PAID_AT_ISO could not be parsed: "${paidAtIso}"`);
}
if (!Number.isFinite(periodEnd) || periodEnd <= paidAt) {
  bail(
    `BACKFILL_PERIOD_END_MS must be a millisecond timestamp AFTER paidAt (${paidAt}), got ${periodEnd}`,
  );
}

async function main() {
  if (!process.env.CLERK_SECRET_KEY) bail("CLERK_SECRET_KEY not set");
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    // Safety valve for a local test run — the in-memory fallback in
    // paymentsStore would silently succeed against nothing. Refuse.
    if (COMMIT) bail("KV creds not set — refusing to --commit against in-memory fallback");
    console.warn(
      "warn: KV creds not set. Continuing in dry-run mode — paymentsStore falls back to in-memory here so any 'created' output is not persisted.",
    );
    __resetInMemoryPaymentsStore();
  }

  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const list = await clerk.users.getUserList({ emailAddress: [email] });
  const found = list.data.filter((u) =>
    (u.emailAddresses || []).some((e) => e.emailAddress.toLowerCase() === email),
  );
  if (found.length === 0) bail(`No Clerk user found for ${email}`);
  if (found.length > 1) bail(`Multiple Clerk users match ${email} — ambiguous, refusing`);
  const user = found[0];

  const plan = user.publicMetadata?.plan;
  const planExpiresAt = user.publicMetadata?.planExpiresAt;
  if (plan !== "enterprise") {
    bail(
      `Refusing: target user's Clerk plan is ${JSON.stringify(plan)}, not "enterprise". If the grant was rolled back, do not backfill.`,
    );
  }
  if (planExpiresAt !== periodEnd) {
    console.warn(
      `warn: Clerk planExpiresAt (${planExpiresAt}) differs from BACKFILL_PERIOD_END_MS (${periodEnd}). The backfill will record periodEnd=${periodEnd}. If you want them aligned, set BACKFILL_PERIOD_END_MS to Clerk's value or fix Clerk first.`,
    );
  }

  const existing = await readPayment(paymentRef);
  if (existing) {
    console.log("Payment record already exists for " + paymentRef + ":");
    console.log(JSON.stringify(existing, null, 2));
    console.log("Nothing to do. (recordPayment is idempotent.)");
    return;
  }

  const planned = {
    paymentRef,
    userId: user.id,
    plan: "enterprise" as const,
    billingCycle: rawCycle,
    amountEsp,
    paidAt,
    periodStart: paidAt,
    periodEnd,
    source: "manual" as const,
  };

  console.log("Would write PaymentRecord:");
  console.log(JSON.stringify(planned, null, 2));
  console.log("");
  console.log("Target Clerk user:");
  console.log("  id:    " + user.id);
  console.log("  email: " + email);
  console.log("  plan:  " + plan);
  console.log("  clerk planExpiresAt: " + planExpiresAt);
  console.log("");

  if (!COMMIT) {
    console.log("Dry run — pass --commit to actually write.");
    return;
  }

  const result = await recordManualGrant(planned);
  if (!result.created) {
    console.log("A race — record already existed. No change:");
    console.log(JSON.stringify(result.record, null, 2));
    return;
  }
  await appendAuditEntry({
    ts: Date.now(),
    permission: "billing:manual-grant",
    allowed: true,
    userId: user.id,
    role: "operator",
    reason: `backfill plan=enterprise cycle=${rawCycle} amountEsp=${amountEsp} ref=${paymentRef}`,
  });
  console.log("Wrote:");
  console.log(JSON.stringify(result.record, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
