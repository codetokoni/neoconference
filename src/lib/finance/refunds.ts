// src/lib/finance/refunds.ts
//
// Refunds, issued from the admin billing area (billing:refund, step-up).
//
//   Stripe ticket sale  -> POST /v1/refunds through the Stripe API. The money
//                          goes back to the card; we never see the card.
//   eSPees plan payment -> eSPees has no refund API NeoConference can call, so
//                          the admin returns the Espees themselves (from the
//                          merchant wallet) and records it here: method
//                          "outside", with the reference of that transfer.
//   Manual payment      -> the same: recorded, not sent.
//
// Either way the payment is marked refunded (or partly refunded), the plan
// can be ended now if the admin asks, and the change is in the admin audit
// log with before and after.

import { kv } from "@/lib/kv";
import { readPayment, updatePaymentRecord } from "@/lib/paymentsStore";
import { createRefund } from "@/lib/stripe";
import { recordAdminAction, type AuditActor } from "@/lib/admin/audit";
import { fmtMoney, normCurrency, round, toMinor } from "@/lib/finance/money";
import {
  readEntry,
  readTicket,
  saveTicket,
  userEntries,
  withPeople,
  type LedgerEntry,
  type PlanPayment,
  type RefundEntry,
} from "@/lib/finance/ledger";
import { endPlanNow, isOwnerAccount } from "@/lib/finance/planChange";

export type RefundMethod = "stripe" | "outside";

/** How a payment can be refunded, for the screen to offer the right form. */
export function refundMethodFor(e: LedgerEntry): RefundMethod | null {
  if (e.status === "failed" || e.status === "refunded") return null;
  return e.provider === "stripe" ? "stripe" : "outside";
}

export interface RefundRequest {
  id: string;
  /** Defaults to everything not yet refunded. */
  amount?: number;
  /** Must equal the payment's currency: the screen showed it, the admin confirmed it. */
  currency: string;
  reason: string;
  /** End the buyer's plan now (plan payments only). */
  downgrade?: boolean;
  /** For an outside refund: the eSPees transfer reference, or a note on how it was paid back. */
  outsideRef?: string;
}

export type RefundOutcome =
  | { ok: true; entry: LedgerEntry; refund: RefundEntry; downgraded: boolean }
  | { ok: false; status: number; error: string; message: string };

const no = (status: number, error: string, message: string): RefundOutcome => ({ ok: false, status, error, message });

export async function refundPayment(actor: AuditActor, req: Request | null, input: RefundRequest): Promise<RefundOutcome> {
  const found = await readEntry(input.id);
  if (!found) return no(404, "not_found", "No such payment.");
  const [entry] = await withPeople([found]);
  const method = refundMethodFor(entry);
  if (!method) return no(409, "not_refundable", entry.status === "failed" ? "A failed payment took no money." : "This payment is already fully refunded.");
  if (normCurrency(input.currency) !== entry.currency) {
    return no(409, "currency_mismatch", `This payment was in ${entry.currency}, not ${normCurrency(input.currency)}. Reload and confirm again.`);
  }
  const remaining = round(entry.amount - entry.refundedAmount, entry.currency);
  const amount = round(input.amount ?? remaining, entry.currency);
  if (!(amount > 0) || amount > remaining + 1e-9) {
    return no(400, "bad_amount", `Refund between 0 and ${fmtMoney(remaining, entry.currency)}.`);
  }
  const reason = (input.reason || "").trim().slice(0, 300);
  if (!reason) return no(400, "reason_required", "Say why the payment is refunded.");
  const outsideRef = (input.outsideRef || "").trim().slice(0, 120);
  if (method === "outside" && !outsideRef) {
    return no(400, "outside_ref_required", "Enter the reference of the transfer that returned the money.");
  }

  const downgrade = !!input.downgrade;
  if (downgrade) {
    if (entry.kind !== "plan" || !entry.userId) return no(400, "not_a_plan", "Only a plan payment can end a plan.");
    if (await isOwnerAccount(entry.userId)) {
      return no(403, "owner_protected", "The platform owner's plan cannot be changed. Refund without ending the plan.");
    }
    // Only the payment behind the plan they have now can end it.
    const latest = (await userEntries(entry.userId)).find((e) => e.kind === "plan" && e.status !== "failed");
    if (latest?.id !== entry.id) {
      return no(409, "not_current", "A later payment is behind this account's current plan. Refund without ending the plan, or refund that payment.");
    }
  }

  // One refund at a time per payment: a double click must not refund twice.
  const lock = `billing:refund:lock:${entry.id}`;
  if ((await kv.set(lock, Date.now(), { nx: true, ex: 60 })) === null) {
    return no(409, "in_progress", "A refund of this payment is already under way.");
  }
  try {
    const before = { status: entry.status, refundedAmount: entry.refundedAmount, currency: entry.currency };
    const refund: RefundEntry = {
      id: `rf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      amount,
      currency: entry.currency,
      at: Date.now(),
      method,
      reason,
      byEmail: actor.email,
      byUserId: actor.userId,
    };

    if (method === "stripe") {
      const t = await readTicket(entry.ref);
      if (!t?.paymentIntent) return no(409, "no_payment_intent", "Stripe did not give this sale a payment id, so it cannot be refunded from here.");
      try {
        const r = await createRefund({
          paymentIntent: t.paymentIntent,
          amountMinor: toMinor(amount, entry.currency),
          idempotencyKey: `neo-refund-${entry.ref}-${(t.refunds ?? []).length}-${toMinor(amount, entry.currency)}`,
          metadata: { neo_admin: actor.email, neo_reason: reason },
        });
        refund.providerRef = r.id;
        refund.providerStatus = r.status;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Stripe refused the refund.";
        await recordAdminAction(actor, req, {
          action: "billing.refund",
          targetType: "payment",
          targetId: entry.id,
          targetLabel: `${entry.ref} (${entry.email ?? entry.userId ?? "guest"})`,
          before,
          note: `${fmtMoney(amount, entry.currency)} via Stripe — ${reason}. Stripe said: ${message}`,
          outcome: "failed",
        });
        return no(502, "stripe_failed", message);
      }
      const fresh = (await readTicket(entry.ref))!;
      const refunds = [...(fresh.refunds ?? []), refund];
      await saveTicket({ ...fresh, refunds, refundedAmount: round(refunds.reduce((s, r) => s + r.amount, 0), entry.currency) });
    } else {
      refund.providerRef = outsideRef;
      const rec = (await readPayment(entry.ref)) as PlanPayment;
      const refunds = [...(rec.refunds ?? []), refund];
      const refundedAmount = round(refunds.reduce((s, r) => s + r.amount, 0), entry.currency);
      await updatePaymentRecord(entry.ref, {
        refunds,
        refundedAmount,
        // The record's own status, which the user's billing page shows.
        ...(refundedAmount + 1e-9 >= rec.amountEsp ? { status: "refunded" as const } : {}),
      });
    }

    let downgraded = false;
    if (downgrade && entry.userId) {
      try {
        const plan = await endPlanNow(entry.userId, actor, `Refund of ${entry.ref}: ${reason}`);
        downgraded = true;
        refund.downgraded = true;
        await recordAdminAction(actor, req, {
          action: "billing.plan.end",
          targetType: "user",
          targetId: entry.userId,
          targetLabel: entry.email ?? entry.userId,
          before: plan.before,
          after: plan.after,
          note: `Plan ended with the refund of ${entry.ref}.`,
        });
      } catch (err) {
        // The money is already back; say so, and that the plan is unchanged.
        await recordAdminAction(actor, req, {
          action: "billing.plan.end",
          targetType: "user",
          targetId: entry.userId,
          targetLabel: entry.email ?? entry.userId,
          note: `Refund of ${entry.ref} done, but ending the plan failed: ${err instanceof Error ? err.message : "unknown"}`,
          outcome: "failed",
        });
      }
      if (downgraded) await markDowngraded(entry, refund.id);
    }

    const after = (await readEntry(entry.id))!;
    await recordAdminAction(actor, req, {
      action: "billing.refund",
      targetType: "payment",
      targetId: entry.id,
      targetLabel: `${entry.ref} (${entry.email ?? entry.userId ?? "guest"})`,
      before,
      after: {
        status: after.status,
        refundedAmount: after.refundedAmount,
        currency: after.currency,
        refund: { amount, currency: entry.currency, method, providerRef: refund.providerRef, providerStatus: refund.providerStatus, downgraded },
      },
      note: reason,
    });
    return { ok: true, entry: after, refund, downgraded };
  } finally {
    await kv.del(lock);
  }
}

async function markDowngraded(entry: LedgerEntry, refundId: string) {
  if (entry.kind !== "plan") return;
  const rec = (await readPayment(entry.ref)) as PlanPayment | null;
  if (!rec) return;
  await updatePaymentRecord(entry.ref, {
    refunds: (rec.refunds ?? []).map((r) => (r.id === refundId ? { ...r, downgraded: true } : r)),
  });
}
