// scripts/grant-plan.ts
//
// Write a Clerk plan grant for a user by email, with optional payment
// record. Designed for one-off operator-driven grants (comp accounts,
// super admins, enterprise deals handled off-band). Not for automated
// checkout flows — those go through /api/billing/espees/return.
//
// Refuses to write without `--commit`. First run prints exactly what it
// would do; verify, then re-run with `--commit`.
//
// Required env:
//   CLERK_SECRET_KEY       — always required
//   KV_REST_API_URL        — only required if recording a payment
//   KV_REST_API_TOKEN      — only required if recording a payment
//
// Configuration env (each has a default in the block below):
//   GRANT_EMAIL            — target user's email
//   GRANT_PLAN             — free | starter | pro | business | enterprise
//   GRANT_EXPIRES_ISO      — ISO date for plan expiry; leave empty for
//                            permanent (no auto-downgrade). Comp grants
//                            (super admins, staff) should stay permanent.
//   GRANT_RECORD_PAYMENT   — "true" to also write a paymentsStore record
//                            with source: "manual". Requires:
//     GRANT_AMOUNT_ESP     — amount actually collected
//     GRANT_PAYMENT_REF    — operator-supplied reference (lives on the
//                            record forever; used as idempotency key)
//     GRANT_CYCLE          — monthly | annual (informational for manual
//                            grants — no server-side cycle enforcement)
//     GRANT_PAID_AT_ISO    — when the payment was actually made
//
// Defaults below are configured for the current ask
// (victoragbasa@gmail.com, super admin + enterprise, comp — no payment).
//
// Runs via tsx from the repo root:
//   npx tsx scripts/grant-plan.ts             # dry run
//   npx tsx scripts/grant-plan.ts --commit    # write
//
// Idempotent on plan write: applies the requested plan even if Clerk
// already shows it, and preserves other publicMetadata fields.
// Idempotent on payment write: recordManualGrant refuses to overwrite
// an existing record with the same paymentRef.

import { createClerkClient } from "@clerk/nextjs/server";
import {
  readPayment,
  recordManualGrant,
  __resetInMemoryPaymentsStore,
} from "../src/lib/paymentsStore";
import { appendAuditEntry } from "../src/lib/auditLog";
import { isPlan, type Plan } from "../src/lib/plan";
import type { BillingCycle } from "../src/lib/espees";

const COMMIT = process.argv.includes("--commit");

const email = (process.env.GRANT_EMAIL || "victoragbasa@gmail.com").trim().toLowerCase();
const plan = (process.env.GRANT_PLAN || "enterprise").trim();
const expiresIso = (process.env.GRANT_EXPIRES_ISO || "").trim();
const recordPayment = (process.env.GRANT_RECORD_PAYMENT || "false").trim().toLowerCase() === "true";

// Payment fields (only consulted when GRANT_RECORD_PAYMENT=true).
const amountEsp = Number(process.env.GRANT_AMOUNT_ESP ?? "0");
const paymentRef = (process.env.GRANT_PAYMENT_REF || "").trim();
const rawCycle = (process.env.GRANT_CYCLE || "monthly").trim() as BillingCycle;
const paidAtIso = (process.env.GRANT_PAID_AT_ISO || "").trim();

function bail(msg: string): never {
  console.error("Error: " + msg);
  process.exit(1);
}

if (!isPlan(plan)) bail(`GRANT_PLAN must be one of free|starter|pro|business|enterprise, got "${plan}"`);
const planExpiresAt = expiresIso ? Date.parse(expiresIso) : null;
if (expiresIso && !Number.isFinite(planExpiresAt)) {
  bail(`GRANT_EXPIRES_ISO could not be parsed: "${expiresIso}"`);
}
if (recordPayment) {
  if (!paymentRef) bail("GRANT_PAYMENT_REF is required when GRANT_RECORD_PAYMENT=true");
  if (!Number.isFinite(amountEsp) || amountEsp <= 0) {
    bail("GRANT_AMOUNT_ESP must be a positive number when GRANT_RECORD_PAYMENT=true");
  }
  if (!paidAtIso) bail("GRANT_PAID_AT_ISO is required when GRANT_RECORD_PAYMENT=true");
  if (rawCycle !== "monthly" && rawCycle !== "annual") {
    bail(`GRANT_CYCLE must be "monthly" or "annual", got "${rawCycle}"`);
  }
  if (planExpiresAt === null) {
    bail("A payment record without an expiry is contradictory. Set GRANT_EXPIRES_ISO too, or leave GRANT_RECORD_PAYMENT=false for a comp grant.");
  }
}

async function main() {
  if (!process.env.CLERK_SECRET_KEY) bail("CLERK_SECRET_KEY not set");
  if (recordPayment && (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN)) {
    if (COMMIT) bail("KV creds not set — refusing to --commit a payment record against in-memory fallback");
    console.warn("warn: KV creds not set. Continuing in dry-run mode — paymentsStore falls back to in-memory here.");
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
  const currentPlan = (user.publicMetadata as { plan?: string } | undefined)?.plan;
  const currentExpiresAt = (user.publicMetadata as { planExpiresAt?: number } | undefined)?.planExpiresAt ?? null;

  const nextPublicMetadata = {
    ...(user.publicMetadata ?? {}),
    plan,
    planExpiresAt,
  };

  console.log("Target Clerk user:");
  console.log("  id:                " + user.id);
  console.log("  email:             " + email);
  console.log("  current plan:      " + JSON.stringify(currentPlan));
  console.log("  current expiresAt: " + currentExpiresAt);
  console.log("");
  console.log("Would set publicMetadata.plan          -> " + plan);
  console.log("Would set publicMetadata.planExpiresAt -> " + (planExpiresAt ?? "null (permanent)"));
  console.log("");

  if (recordPayment) {
    const existing = await readPayment(paymentRef);
    if (existing) {
      console.log("A paymentsStore record already exists for ref " + paymentRef + ":");
      console.log(JSON.stringify(existing, null, 2));
      console.log("(recordManualGrant is idempotent — the plan write above still runs.)");
    } else {
      const paidAt = Date.parse(paidAtIso);
      console.log("Would also write PaymentRecord:");
      console.log(
        JSON.stringify(
          {
            paymentRef,
            userId: user.id,
            plan,
            billingCycle: rawCycle,
            amountEsp,
            source: "manual",
            paidAt,
            periodStart: paidAt,
            periodEnd: planExpiresAt,
          },
          null,
          2,
        ),
      );
    }
  } else {
    console.log("No paymentsStore record will be written (comp grant).");
  }
  console.log("");

  if (!COMMIT) {
    console.log("Dry run — pass --commit to actually write.");
    return;
  }

  await clerk.users.updateUserMetadata(user.id, {
    publicMetadata: nextPublicMetadata,
  });
  console.log("Wrote Clerk publicMetadata for " + user.id);

  if (recordPayment) {
    const paidAt = Date.parse(paidAtIso);
    const result = await recordManualGrant({
      paymentRef,
      userId: user.id,
      plan: plan as Plan,
      billingCycle: rawCycle,
      amountEsp,
      paidAt,
      periodStart: paidAt,
      periodEnd: planExpiresAt!,
    });
    if (result.created) {
      console.log("Wrote PaymentRecord " + paymentRef);
    } else {
      console.log("PaymentRecord " + paymentRef + " already existed — no change:");
      console.log(JSON.stringify(result.record, null, 2));
    }
  }

  await appendAuditEntry({
    ts: Date.now(),
    permission: "billing:manual-grant",
    allowed: true,
    userId: user.id,
    role: "operator",
    reason: `grant plan=${plan} expiresAt=${planExpiresAt ?? "permanent"}${
      recordPayment ? ` amountEsp=${amountEsp} ref=${paymentRef}` : " (comp — no payment recorded)"
    }`,
  });
  console.log("Appended audit-log entry.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
