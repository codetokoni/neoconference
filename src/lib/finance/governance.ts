// src/lib/finance/governance.ts
//
// What the finance store holds about one person, for data governance
// (account export and deletion). Payments and invoices are kept for legal
// retention; deletion detaches them from the person instead of removing
// them: amounts, numbers, dates, tax and the pseudonymous user id stay,
// names and email addresses go.
//
// Personal fields this phase stores:
//   billing:ticket:<sessionId>     email, name (from Stripe Checkout)
//   billing:invoice:<ledger id>    buyer.name, buyer.email
//   billing:reminders:log          email of the person reminded
// Plan payment records (paymentsStore) are handled by data governance
// itself; the fields this phase adds to them (country, refunds, failure
// reason) hold nothing personal. No card data is stored anywhere.

import { kv } from "@/lib/kv";
import { forgetUser, readTicket, saveTicket, userEntries, type LedgerEntry } from "@/lib/finance/ledger";
import { readInvoice, type Invoice } from "@/lib/finance/invoice";
import { listCheckouts, type CheckoutLog } from "@/lib/finance/checkouts";
import { readReminderLog, type ReminderLogEntry } from "@/lib/finance/reminders";

const REMINDER_LOG = "billing:reminders:log";

export interface FinanceRecords {
  payments: LedgerEntry[];
  invoices: Invoice[];
  checkouts: CheckoutLog[];
  reminders: ReminderLogEntry[];
}

/** Everything this phase holds about a user, for their data export. */
export async function financeRecordsForUser(userId: string): Promise<FinanceRecords> {
  const payments = await userEntries(userId);
  const invoices = (await Promise.all(payments.map((p) => readInvoice(p.id)))).filter((i): i is Invoice => !!i);
  const now = Date.now();
  const checkouts = (await listCheckouts(0, now)).filter((c) => c.userId === userId);
  const reminders = (await readReminderLog(500)).filter((r) => r.userId === userId);
  return { payments, invoices, checkouts, reminders };
}

/**
 * Blank the personal fields on this user's ticket sales, invoices and
 * reminder log lines. `email` also catches guest ticket purchases made with
 * that address while signed out. Safe to run twice. Returns how many records
 * were changed.
 */
export async function anonymiseFinanceForUser(userId: string, opts: { email?: string } = {}): Promise<{ records: number }> {
  const email = opts.email?.trim().toLowerCase() || null;
  let records = 0;

  const mine = await userEntries(userId);
  const tickets = new Set(mine.filter((e) => e.kind === "ticket").map((e) => e.ref));
  if (email) {
    for (const k of ((await kv.keys("billing:ticket:cs_*")) ?? []) as string[]) {
      const t = await readTicket(k.slice("billing:ticket:".length));
      if (t && t.email === email) tickets.add(t.sessionId);
    }
  }
  for (const sid of tickets) {
    const t = await readTicket(sid);
    if (!t || (t.email == null && t.name == null)) continue;
    await saveTicket({ ...t, email: null, name: null });
    records++;
  }

  const ids = new Set([...mine.map((e) => e.id), ...[...tickets].map((s) => `tkt:${s}`)]);
  for (const id of ids) {
    const inv = await readInvoice(id);
    if (!inv || (inv.buyer.name == null && inv.buyer.email == null)) continue;
    await kv.set(`billing:invoice:${id}`, { ...inv, buyer: { ...inv.buyer, name: null, email: null } });
    records++;
  }

  const log = await readReminderLog(500);
  if (log.some((l) => l.userId === userId && l.email)) {
    const next = log.map((l) => (l.userId === userId && l.email ? (records++, { ...l, email: null }) : l));
    await kv.del(REMINDER_LOG);
    // Newest first, as the log is kept.
    for (const l of [...next].reverse()) await kv.lpush(REMINDER_LOG, JSON.stringify(l));
  }

  forgetUser(userId);
  return { records };
}
