// src/lib/paymentsStore.ts
//
// Permanent record of every plan upgrade. Sits alongside the existing
// billingStore.ts, which is a short-TTL nonce table for the checkout
// handshake — that record disappears after ~1 hour so it can't back a
// billing page, an invoice or a receipt. This one has no TTL.
//
// Task 1 of docs/BILLING-HANDOFF.md — write payment records in the same
// handler that writes Clerk metadata, so the two can never disagree.
//
// Every completed upgrade lands as one PaymentRecord keyed by paymentRef
// (idempotent — a refreshed return URL must not mint a duplicate). The
// dashboard billing page (Task 2) reads through the per-user list.
// Invoice numbers (Task 3) are assigned lazily on first invoice request
// and then frozen on the record.
//
// Storage: Vercel KV only (constraint from the handoff — no Postgres,
// no Prisma). In-memory fallback for tests and unconfigured
// environments, matching the auditLog.ts / attendance.ts pattern.

import { kv } from "@vercel/kv";
import type { Plan } from "@/lib/plan";
import type { BillingCycle } from "@/lib/espees";

const PAYMENT_KEY_PREFIX = "billing:payment:";
const USER_LIST_KEY_PREFIX = "billing:payments:";
const INVOICE_SEQ_KEY = "billing:invoice:seq";

// Cap the per-user list at a generous number. Anyone who exceeds this has
// hit corner-case territory (a monthly subscription for ~40 years) and
// history rendering can page from newest anyway.
const MAX_USER_LIST_ENTRIES = 500;

// Format for invoice numbers. Simple zero-padded counter — invoice PDFs
// (Task 3) can prefix if the legal entity later demands a jurisdictional
// scheme. Sequential + gap-free is what invoicing regulations care about.
const INVOICE_NUMBER_PREFIX = "NEO-";
const INVOICE_NUMBER_PAD = 6;

export type PaymentSource =
  /** Redirect trusted without an eSpees server-to-server confirmation.
   *  See docs/BILLING-HANDOFF.md §2 — this is the assumed-paid state until
   *  eSpees exposes a webhook or a status-lookup endpoint. */
  | "espees-redirect-unverified"
  /** Reserved for when the redirect grant has been reconciled with an
   *  eSpees callback or lookup. Not written by any code yet. */
  | "espees-verified"
  /** Enterprise deals granted by hand in Clerk with an operator-supplied
   *  amount. See recordManualGrant(). */
  | "manual";

export type PaymentStatus = "paid" | "refunded" | "failed";

export interface PaymentRecord {
  /** eSpees payment_ref (or the operator-supplied ref for manual grants).
   *  This is the KV key suffix and the caller-visible idempotency key —
   *  any second write with the same ref returns the first record verbatim. */
  paymentRef: string;
  userId: string;
  plan: Plan;
  billingCycle: BillingCycle;
  /** Price in ESP at the moment of purchase — pulled from ESPEES_AMOUNTS
   *  in the caller so it can never drift from /pricing. Manual grants
   *  pass an operator-supplied number. */
  amountEsp: number;
  status: PaymentStatus;
  /** Unix ms. */
  paidAt: number;
  periodStart: number;
  /** Must equal the planExpiresAt written to Clerk for this upgrade so
   *  the two can never disagree (acceptance criterion 1). */
  periodEnd: number;
  source: PaymentSource;
  /** Assigned lazily by assignInvoiceNumber() on first invoice request,
   *  then frozen. Absent until the invoice is first generated. */
  invoiceNumber?: string;
}

function paymentKey(paymentRef: string): string {
  return PAYMENT_KEY_PREFIX + paymentRef;
}

function userListKey(userId: string): string {
  return USER_LIST_KEY_PREFIX + userId;
}

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

/* ------------------------------------------------------------------ */
/*  In-memory fallback                                                  */
/* ------------------------------------------------------------------ */
// Mirrors the pattern in auditLog.ts / attendance.ts. Not durable — for
// tests and local dev without KV creds.

const memPayments = new Map<string, PaymentRecord>();
const memUserList = new Map<string, string[]>();
let memInvoiceSeq = 0;

/* ------------------------------------------------------------------ */
/*  Reads                                                               */
/* ------------------------------------------------------------------ */

export async function readPayment(
  paymentRef: string,
): Promise<PaymentRecord | null> {
  const ref = (paymentRef || "").trim();
  if (!ref) return null;
  if (!isKvConfigured()) {
    return memPayments.get(ref) ?? null;
  }
  const v = await kv.get<PaymentRecord>(paymentKey(ref));
  return v ?? null;
}

/**
 * Newest-first slice of a user's payment history. The billing page (Task 2)
 * reads through this. `limit` is bounded by MAX_USER_LIST_ENTRIES.
 */
export async function listUserPayments(
  userId: string,
  limit = 50,
): Promise<PaymentRecord[]> {
  const id = (userId || "").trim();
  if (!id) return [];
  const capped = Math.max(1, Math.min(limit, MAX_USER_LIST_ENTRIES));
  const refs: string[] = [];
  if (!isKvConfigured()) {
    const list = memUserList.get(id) || [];
    refs.push(...list.slice(0, capped));
  } else {
    const raw = (await kv.lrange(userListKey(id), 0, capped - 1)) as unknown[];
    for (const r of raw) {
      if (typeof r === "string") refs.push(r);
    }
  }
  const out: PaymentRecord[] = [];
  for (const ref of refs) {
    const rec = await readPayment(ref);
    if (rec) out.push(rec);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Input to recordPayment. `status` defaults to "paid", `source` defaults
 * to "espees-redirect-unverified" (the caller from the eSpees return
 * handler passes exactly this; other callers set it explicitly).
 */
export interface RecordPaymentInput {
  paymentRef: string;
  userId: string;
  plan: Plan;
  billingCycle: BillingCycle;
  amountEsp: number;
  periodStart: number;
  periodEnd: number;
  source?: PaymentSource;
  status?: PaymentStatus;
  paidAt?: number;
}

export interface RecordPaymentResult {
  /** True if this call actually wrote the record; false if a prior write
   *  was found and the existing record is returned unchanged. The caller
   *  uses this to decide whether to also emit an audit entry / receipt. */
  created: boolean;
  record: PaymentRecord;
}

/**
 * Idempotent by paymentRef. A second call with the same ref returns the
 * existing record verbatim without re-appending to the user list and
 * without touching invoiceNumber. See acceptance criterion 2 — refreshing
 * the return URL must not create a duplicate.
 */
export async function recordPayment(
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  const ref = (input.paymentRef || "").trim();
  if (!ref) {
    throw new Error("recordPayment requires a non-empty paymentRef");
  }
  const existing = await readPayment(ref);
  if (existing) {
    return { created: false, record: existing };
  }
  const record: PaymentRecord = {
    paymentRef: ref,
    userId: input.userId,
    plan: input.plan,
    billingCycle: input.billingCycle,
    amountEsp: input.amountEsp,
    status: input.status ?? "paid",
    paidAt: input.paidAt ?? Date.now(),
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    source: input.source ?? "espees-redirect-unverified",
  };
  if (!isKvConfigured()) {
    memPayments.set(ref, record);
    const list = memUserList.get(input.userId) || [];
    list.unshift(ref);
    if (list.length > MAX_USER_LIST_ENTRIES) list.length = MAX_USER_LIST_ENTRIES;
    memUserList.set(input.userId, list);
    return { created: true, record };
  }
  await kv.set(paymentKey(ref), record);
  await kv.lpush(userListKey(input.userId), ref);
  await kv.ltrim(userListKey(input.userId), 0, MAX_USER_LIST_ENTRIES - 1);
  return { created: true, record };
}

/**
 * Enterprise manual-grant path. The pricing page routes enterprise CTAs
 * to email, and those grants are made by hand in Clerk (see the
 * BOOTSTRAP_BUSINESS_EMAIL note in plan.ts). The operator then calls this
 * with the amount actually collected off-band and their own ref.
 *
 * Same idempotency semantics as recordPayment.
 */
export interface ManualGrantInput {
  paymentRef: string;
  userId: string;
  plan: Plan;
  billingCycle: BillingCycle;
  amountEsp: number;
  periodStart: number;
  periodEnd: number;
  paidAt?: number;
}

export async function recordManualGrant(
  input: ManualGrantInput,
): Promise<RecordPaymentResult> {
  return recordPayment({ ...input, source: "manual" });
}

/**
 * Assign an invoice number to a payment on first invoice request, then
 * freeze it. Idempotent: subsequent calls return the same number without
 * bumping the sequence. Used by Task 3 (invoice PDF).
 *
 * Sequence key is `billing:invoice:seq`, monotonically increasing.
 * Numbers are formatted as `NEO-000001` etc so they're recognisable and
 * sortable but the format is centralised here for future changes.
 */
export async function assignInvoiceNumber(
  paymentRef: string,
): Promise<{ number: string; assigned: boolean }> {
  const ref = (paymentRef || "").trim();
  if (!ref) throw new Error("assignInvoiceNumber requires a non-empty paymentRef");
  const existing = await readPayment(ref);
  if (!existing) throw new Error("payment_not_found");
  if (existing.invoiceNumber) {
    return { number: existing.invoiceNumber, assigned: false };
  }
  let seq: number;
  if (!isKvConfigured()) {
    memInvoiceSeq += 1;
    seq = memInvoiceSeq;
  } else {
    seq = (await kv.incr(INVOICE_SEQ_KEY)) as number;
  }
  const number = INVOICE_NUMBER_PREFIX + String(seq).padStart(INVOICE_NUMBER_PAD, "0");
  const updated: PaymentRecord = { ...existing, invoiceNumber: number };
  if (!isKvConfigured()) {
    memPayments.set(ref, updated);
  } else {
    await kv.set(paymentKey(ref), updated);
  }
  return { number, assigned: true };
}

/* ------------------------------------------------------------------ */
/*  Test seams                                                          */
/* ------------------------------------------------------------------ */

/** Reset the in-memory fallback. No-op when KV is configured. */
export function __resetInMemoryPaymentsStore(): void {
  memPayments.clear();
  memUserList.clear();
  memInvoiceSeq = 0;
}
