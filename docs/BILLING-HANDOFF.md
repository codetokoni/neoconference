# Handoff: billing records, invoices and the unverified-upgrade hole

**For:** Claude Code, working in the NeoConference repo
**From:** a Cowork session on 29 Aug 2026 that inspected the running production deployment
**Read this whole file before writing code.**

---

## 0. How this was researched (and what it means for you)

Everything in §1 was read from the **deployed source of production commit `d2e8ff0`** (Vercel → Deployments → Source), not from the local working tree. `main` may have moved since. **Verify each file before editing it** — if what you find differs from what is described here, trust the repo and tell the user what changed.

Files I read in full or in part:

- `src/lib/plan.ts` — read
- `src/lib/billingStore.ts` — read (header + types)
- `src/lib/espees.ts` — read in full (145 lines)
- `src/app/api/billing/espees/return/route.ts` — read (header + first ~45 lines)

Files I did **not** read, and you must read first:

- `src/app/api/billing/espees/checkout/route.ts`
- `src/app/api/billing/espees/fail/route.ts`
- `src/lib/mail.ts` (transport is unknown)
- `src/lib/auditLog.ts`
- `src/app/api/cron/*` (the downgrade cron)

---

## 1. Verified current state

### Plan model — `src/lib/plan.ts`

```ts
export type Plan = "free" | "starter" | "pro" | "business" | "enterprise";

export type PlanMetadata = {
  plan?: Plan;
  planExpiresAt?: number; // unix ms; absent or null means "no expiry / permanent"
};
```

- The plan lives in **Clerk `publicMetadata`**. There is no plans table.
- `isPlanExpired(metadata)` → `Date.now() > planExpiresAt`; absent/null means never expires.
- `computePlanExpiry(billingCycle)` → `Date.now() + (annual ? 365 : 30) days`. **Monthly is 30 days, not one calendar month.**
- `getPlanLimits(plan)` returns `meetingMinutes`, `maxParticipants`, `lifetimeMeetingCap`, `recording`, `recordingHoursPerMonth`, `breakouts`, `branding`.
- A `BOOTSTRAP_BUSINESS_EMAIL` env var auto-promotes the matching user to `business`. **Consequence: you cannot test upgrades on the project owner's account — the promotion masks both success and failure.** Test on a throwaway account.

### Pending payments — `src/lib/billingStore.ts`

- Vercel KV. Key prefix `billing:pending:`, **TTL 3600 seconds (1 hour)**.
- `PendingPayment = { nonce, userId, plan, billingCycle, status, paymentRef, createdAt }`, `PendingPaymentStatus = "pending" | "paid" | "failed"`.
- `generateNonce()` — 24 random bytes via Web Crypto, hex.
- Exports used by the return route: `readPendingPayment`, `updatePaymentStatus`.
- **After one hour the record is gone. Nothing else records that a payment happened.**

### eSpees integration — `src/lib/espees.ts`

- `POST https://api.espees.org/v2/payment/product`, header `x-api-key`, body carries `merchant_wallet`; response `{ statusCode, message, payment_ref, url }`.
- Env: `ESPEES_API_KEY`, `ESPEES_MERCHANT_WALLET`, `ESPEES_PRODUCT_SKU` (single SKU; the older per-plan SKU vars are dead but kept in Vercel for rollback).
- Prices — **the single source of truth, reuse it, never hardcode**:

```ts
export const ESPEES_AMOUNTS: Record<EspeesPlan, Record<BillingCycle, number>> = {
  starter:  { monthly: 10, annual: 100 },
  pro:      { monthly: 20, annual: 200 },
  business: { monthly: 30, annual: 300 },
};
```

- `EspeesPlan = "starter" | "pro" | "business"` — **`enterprise` is deliberately absent**; the pricing page routes Enterprise to `mailto:info@neoconference.app`, and those grants are made by hand in Clerk.
- Only one function exists: `initiatePayment(input) → { ok: true, url, paymentRef } | { ok: false, error }`. **There is no status/verify call and no webhook handler anywhere in the repo.**

### The return handler — `src/app/api/billing/espees/return/route.ts`

`GET /api/billing/espees/return?nonce=<hex>`, `runtime = "nodejs"`, `dynamic = "force-dynamic"`.

1. Missing nonce → redirect `/pricing?error=missing_nonce` (303)
2. `readPendingPayment(nonce)` returns nothing → `/pricing?error=expired_or_unknown` (303)
3. `record.status === "paid"` → redirect `/dashboard?upgraded=<plan>` (idempotent on refresh)
4. Otherwise: mark paid, write `plan` + `planExpiresAt` to Clerk, redirect to the dashboard

Its own comment:

```
// Honest gap: without an eSpees server-to-server webhook, we cannot
// independently verify the payment cleared. v1 trusts the redirect; we
// will harden when eSpees publishes a verify endpoint or webhook.
```

### What does not exist

- No `/billing` route anywhere. `src/app/dashboard/` has `developers`, `e`, `new`, `recordings`, `settings`, `page.tsx`.
- No invoice generation, no receipt email, no payment history, no reconciliation.

### Useful dependencies already installed

`@vercel/kv` 3.0.0 · `@clerk/nextjs` 6.39.3 · `pdf-lib` 1.17.1 · `docx` · `exceljs` · `jose` · `next` 14.2.35

**Storage constraint: this project uses Vercel KV only.** There is no Postgres and no Prisma. Do not introduce a database without asking the user.

---

## 2. Priority 0 — the self-upgrade hole

The nonce is the sole bearer token for an upgrade, and it is handed to the person paying (it is in their address bar on the redirect).

**Exploit:** start a checkout, abandon the payment, then visit `/api/billing/espees/return?nonce=<their own nonce>` within the hour. Plan granted, nothing paid.

**Mirror failure:** a customer pays, closes the tab before the redirect, the pending record expires — no upgrade, no trace, no way to reconcile.

The real fix needs eSpees to expose a webhook or a payment-status lookup keyed on `payment_ref`. The user is asking them. Until that exists, implement mitigations, not a false sense of verification:

1. Stamp every redirect-granted upgrade `source: "espees-redirect-unverified"` on the payment record (Task 1), so proven and assumed can be told apart later.
2. Write an `auditLog` entry on every upgrade.
3. Email the operator on every upgrade (Task 5 covers the transport).
4. Do **not** silently extend the pending TTL as a "fix" — a longer TTL widens the exploit window. If you extend it for reconciliation, gate the grant behind a verification step.

---

## 3. Task 1 — persist payments (do this first)

**New file: `src/lib/paymentsStore.ts`**, Vercel KV, no TTL.

Record shape (adjust names to match repo conventions you find):

```ts
export type PaymentSource = "espees-redirect-unverified" | "espees-verified" | "manual";

export type PaymentRecord = {
  paymentRef: string;      // idempotency key
  userId: string;
  plan: Plan;
  billingCycle: BillingCycle;
  amountEsp: number;       // from ESPEES_AMOUNTS — never hardcode
  status: "paid" | "refunded" | "failed";
  paidAt: number;          // unix ms
  periodStart: number;
  periodEnd: number;       // matches the planExpiresAt written to Clerk
  source: PaymentSource;
  invoiceNumber?: string;
};
```

Keys:

- `billing:payment:<paymentRef>` → the record (lookup + idempotency)
- `billing:payments:<userId>` → list of paymentRefs, newest first (the billing page reads this)
- `billing:invoice:seq` → integer counter for invoice numbering

Requirements:

- **Idempotent on `paymentRef`.** A refreshed success page must not create a second record or a second invoice number.
- Written in the **same handler** that writes Clerk metadata, so the two can never disagree.
- Include a `recordManualGrant()` path for Enterprise deals made by hand in Clerk, with `source: "manual"` and an operator-supplied amount.

**Backfill:** one Enterprise grant exists already — Clerk Production user *ROR Media Control Room* / `rhapsodybrandsandcomms@gmail.com`, `{ "plan": "enterprise", "planExpiresAt": 1790636399000 }` (28 Sep 2026 23:59 WAT), granted manually on 29 Aug 2026. Ask the user for the amount and reference before backfilling it — do not invent them.

**Edit: `src/app/api/billing/espees/return/route.ts`** — write the payment record alongside the existing Clerk update, plus the audit-log entry from §2.

---

## 4. Task 2 — `/dashboard/billing`

New route `src/app/dashboard/billing/page.tsx`, server-rendered from Clerk metadata + `paymentsStore`.

- Current plan, renewal date from `planExpiresAt`, days remaining, change-plan link to `/pricing`.
- Payment history table: date, plan, cycle, amount (ESP), reference, status, invoice link.
- Free-plan empty state that sells the upgrade rather than showing an empty table.
- Show unverified payments distinctly to admins only — do not expose the `source` wording to end users.

---

## 5. Task 3 — invoice PDF

`src/app/api/billing/invoice/[paymentRef]/route.ts`, using `pdf-lib` (already installed — do not add a PDF dependency).

- Authorise: owning user or admin. Never let a bare `paymentRef` be enough.
- Invoice number assigned once, on first generation, then stored on the record — regenerating must return the same number.
- Contents: number, issue date, bill-to (Clerk name + primary email), line item (plan, cycle, period start–end), amount in Espees, payment reference, paid marker.
- **Blocked on the user:** legal entity name, address, tax registration; whether to show a fiat equivalent (if so, the rate must be captured at payment time and stored on the record, never computed at render time).

---

## 6. Task 4 — receipt email

- Send on successful return, with the invoice linked or attached.
- Intended sender: `billing@neoconference.app` (the domain now delivers through a self-hosted Stalwart server at `mail.neoemail.org`; the alias takes a minute to add — ask the user).
- **Read `src/lib/mail.ts` first** — its transport is unknown and may have no path for this domain. If it does not, submitting over SMTP on port 465 to `mail.neoemail.org` with an authenticated account is available; ask the user for credentials rather than inventing env var names.
- The same hook carries the operator alert from §2.

---

## 7. Acceptance criteria

1. A completed checkout produces exactly one `billing:payment:<paymentRef>` record whose `periodEnd` equals the `planExpiresAt` written to Clerk.
2. Refreshing the return URL changes nothing — no duplicate record, no second invoice number, no extended expiry.
3. `/dashboard/billing` shows that payment for the paying user, and nothing for a free user.
4. The invoice PDF for that payment is downloadable by its owner, and 403/404 for anyone else.
5. Amounts on the page and the invoice come from `ESPEES_AMOUNTS`, so they cannot drift from `/pricing`.
6. Every upgrade leaves an audit-log entry.

**Test on a throwaway account, not the owner's** — see the `BOOTSTRAP_BUSINESS_EMAIL` note in §1. A test payment made from the owner account on 29 Aug left no `plan` in Clerk at all, and there is no way to tell from inside the app whether it cleared.

---

## 8. Ask the user before you build

1. Legal entity, address and tax registration for the invoice header.
2. Espees only on invoices, or a fiat equivalent too?
3. Amount and reference for the ROR Media Enterprise grant, for the backfill.
4. How manual Enterprise deals should be recorded going forward — an admin form, or a script?
5. Renewal warning email before the downgrade cron runs, and a one-click repurchase — in scope or later?
