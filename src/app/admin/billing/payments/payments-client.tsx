"use client";

// Payments: every payment the platform has taken (eSPees plans, manual
// grants, Stripe ticket sales), filterable and searchable, with totals per
// currency, invoices, refunds and exports.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Badge, Confirm, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../../ui";
import { fmtMoney, type ByCurrency } from "@/lib/finance/money";
import { BillingNav, Money, PROVIDER_LABEL, StatusBadge, Totals, customerHref, day, invoiceHref, type Entry } from "../shared";

type Page = {
  items: Entry[];
  total: number;
  totals: { paid: ByCurrency; refunded: ByCurrency; failed: ByCurrency };
  indexed: number;
};

const PAGE = 50;
const EMPTY = { from: "", to: "", status: "", provider: "", plan: "", user: "", q: "" };

export default function PaymentsClient() {
  const { can, adminFetch } = useAdmin();
  // Filters come from the URL (same names as the API) and stay in it, so a
  // link such as ?status=failed&from=2026-09-01 opens filtered, and ?open=<id>
  // opens one payment.
  const params = useSearchParams();
  const fromUrl = useMemo(
    () => Object.fromEntries(Object.keys(EMPTY).map((k) => [k, params?.get(k) ?? ""])) as typeof EMPTY,
    // Read once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [filters, setFilters] = useState(fromUrl);
  const [applied, setApplied] = useState(fromUrl);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(() => params?.get("open") || null);
  const [reload, setReload] = useState(0);
  const [confirmBackfill, setConfirmBackfill] = useState(false);

  const query = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...applied, ...extra })) if (v) p.set(k, v);
      return p.toString();
    },
    [applied],
  );

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    adminFetch<Page>(`/api/admin/billing/payments?${query({ limit: String(PAGE), offset: String(offset) })}`).then((r) => {
      if (!live) return;
      if (r.ok) setData(r.data);
      else setError(r.data.message ?? "Could not load payments.");
    });
    return () => {
      live = false;
    };
  }, [adminFetch, query, offset, reload]);

  useEffect(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(applied)) if (v) p.set(k, v);
    if (open) p.set("open", open);
    const qs = p.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, [applied, open]);

  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [k]: e.target.value });

  const backfill = async () => {
    setConfirmBackfill(false);
    const r = await adminFetch<{ result: { planPayments: number; ticketSales: number; stripe: string; stripeError?: string; indexSize: number } }>("/api/admin/billing/backfill", { method: "POST" });
    if (!r.ok) return setError(r.data.message ?? "The backfill failed.");
    const x = r.data.result;
    setNotice(
      `Listed ${x.planPayments} plan payment${x.planPayments === 1 ? "" : "s"} and ${x.ticketSales} Stripe ticket sale${x.ticketSales === 1 ? "" : "s"}; ${x.indexSize} in the index.` +
        (x.stripe === "not_configured" ? " Stripe is not configured, so no ticket sales were read from it." : x.stripe === "failed" ? ` Reading Stripe failed: ${x.stripeError}` : ""),
    );
    setReload((n) => n + 1);
  };

  return (
    <div>
      <PageHeader
        title="Billing"
        sub="Every payment, with amounts in the currency they were paid in. Totals are per currency and never added across currencies."
        actions={
          can("billing:settings") && (
            <button type="button" className={btn.ghost} onClick={() => setConfirmBackfill(true)} title="List payments made before this page existed">
              Rebuild index
            </button>
          )
        }
      />
      <BillingNav active="payments" />
      {notice && (
        <Notice kind="ok" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      )}
      <p className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-100/90">
        eSPees offers no way for NeoConference to confirm a payment, no webhook and no refund call. Plan payments are recorded when the buyer&apos;s browser returns from eSPees and are marked <b>unverified</b>; eSPees refunds are made from the merchant wallet and recorded here. Stripe ticket sales are confirmed by Stripe and refunded through Stripe.
      </p>

      <Panel className="mb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setApplied(filters);
          }}
          className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
        >
          <input aria-label="Search" placeholder="Reference, invoice, email, name" value={filters.q} onChange={set("q")} className={field} />
          <input aria-label="Customer" placeholder="Customer email or user id" value={filters.user} onChange={set("user")} className={field} />
          <select aria-label="Status" value={filters.status} onChange={set("status")} className={field}>
            <option value="">Any status</option>
            <option value="paid">Paid</option>
            <option value="partially_refunded">Partly refunded</option>
            <option value="refunded">Refunded</option>
            <option value="refunds">Any refund</option>
            <option value="failed">Failed</option>
          </select>
          <select aria-label="Provider" value={filters.provider} onChange={set("provider")} className={field}>
            <option value="">Any provider</option>
            <option value="espees">eSPees</option>
            <option value="stripe">Stripe</option>
            <option value="manual">Manual</option>
          </select>
          <select aria-label="Plan" value={filters.plan} onChange={set("plan")} className={field}>
            <option value="">Any plan or ticket</option>
            <option value="starter">Starter</option>
            <option value="pro">Pro</option>
            <option value="business">Business</option>
            <option value="enterprise">Enterprise</option>
            <option value="ticket">Event tickets</option>
          </select>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            From
            <input type="date" value={filters.from} onChange={set("from")} className={field} />
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            To
            <input type="date" value={filters.to} onChange={set("to")} className={field} />
          </label>
          <div className="flex gap-2">
            <button type="submit" className={btn.primary}>
              Apply
            </button>
            <button
              type="button"
              className={btn.ghost}
              onClick={() => {
                setFilters(EMPTY);
                setApplied(EMPTY);
                setOffset(0);
              }}
            >
              Clear
            </button>
          </div>
        </form>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-zinc-500">Dates are whole days in UTC. Times below are in your local time zone.</p>
          {can("reports:export") && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              <span className="self-center text-zinc-500">Export</span>
              {(
                [
                  ["payments", "csv", "Payments CSV"],
                  ["payments", "xlsx", "Payments Excel"],
                  ["refunds", "csv", "Refunds CSV"],
                  ["refunds", "xlsx", "Refunds Excel"],
                ] as const
              ).map(([type, format, label]) => (
                <a key={label} className={btn.ghost} href={`/api/admin/billing/export?${query({ type, format })}`}>
                  {label}
                </a>
              ))}
            </div>
          )}
        </div>
      </Panel>

      {error && <Notice kind="err">{error}</Notice>}
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Stat label={`Received (${data.total} payment${data.total === 1 ? "" : "s"} match)`}>
              <Totals totals={data.totals.paid} />
            </Stat>
            <Stat label="Refunded">
              <Totals totals={data.totals.refunded} />
            </Stat>
            <Stat label="Failed (not taken)">
              <Totals totals={data.totals.failed} />
            </Stat>
          </div>
          {data.items.length === 0 ? (
            <Empty>
              No payments match.
              {data.indexed === 0 && can("billing:settings") && " If payments were taken before this page existed, use Rebuild index to list them."}
            </Empty>
          ) : (
            <Panel className="overflow-x-auto p-0">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Customer</th>
                    <th className="px-3 py-2 font-medium">What</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                    <th className="px-3 py-2 font-medium">Provider</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((e) => (
                    <tr key={e.id} className="cursor-pointer border-t border-white/5 hover:bg-white/[0.03]" onClick={() => setOpen(e.id)}>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400">{fmtTime(e.at)}</td>
                      <td className="max-w-[200px] truncate px-3 py-2 text-zinc-200">{e.email ?? e.name ?? e.userId ?? "Guest"}</td>
                      <td className="max-w-[240px] truncate px-3 py-2 text-zinc-300">{e.description}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-zinc-100">
                        <Money amount={e.amount} currency={e.currency} />
                        {e.refundedAmount > 0 && e.status !== "refunded" && (
                          <div className="text-[11px] text-red-300">−{fmtMoney(e.refundedAmount, e.currency)}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-400">{PROVIDER_LABEL[e.provider]}</td>
                      <td className="px-3 py-2">
                        <StatusBadge e={e} />
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-zinc-400">{e.invoiceNumber ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-white/5 px-3 py-2 text-xs text-zinc-400">
                <span>
                  {offset + 1}–{offset + data.items.length} of {data.total} · {data.indexed} indexed
                </span>
                <div className="flex gap-2">
                  <button type="button" className={btn.ghost} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                    Newer
                  </button>
                  <button type="button" className={btn.ghost} disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
                    Older
                  </button>
                </div>
              </div>
            </Panel>
          )}
        </>
      )}

      {open && (
        <PaymentDetail
          id={open}
          onClose={() => setOpen(null)}
          onChanged={(msg) => {
            setNotice(msg);
            setReload((n) => n + 1);
          }}
        />
      )}
      {confirmBackfill && (
        <Confirm
          title="Rebuild the payments index?"
          body="Lists every plan payment already stored and, when Stripe is configured, every completed ticket sale in Stripe. It only adds to the list; nothing is changed or removed."
          confirmLabel="Rebuild"
          onConfirm={backfill}
          onCancel={() => setConfirmBackfill(false)}
        />
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Panel>
      <p className="text-xs text-zinc-500">{label}</p>
      <div className="mt-1 text-lg font-semibold text-white">{children}</div>
    </Panel>
  );
}

type Detail = {
  entry: Entry;
  invoice: { number: string } | null;
  refund: { method: "stripe" | "outside" | null; remaining: number; currency: string; canEndPlan: boolean };
  account: { plan: string | null; planExpiresAt: number | null; exists: boolean } | null;
  others: Entry[];
};

function PaymentDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (msg: string) => void }) {
  const { can, adminFetch } = useAdmin();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    let live = true;
    adminFetch<Detail>(`/api/admin/billing/payments/${encodeURIComponent(id)}`).then((r) => {
      if (!live) return;
      if (r.ok) setD(r.data);
      else setError(r.data.message ?? "Could not load the payment.");
    });
    return () => {
      live = false;
    };
  }, [adminFetch, id, n]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const e = d?.entry;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="pay-title" className="fixed inset-0 z-[80] flex justify-end bg-black/60" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto border-l border-white/10 bg-[#0B1220] p-5" onClick={(ev) => ev.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <h2 id="pay-title" className="text-lg font-semibold text-white">
            Payment
          </h2>
          <button type="button" className={btn.ghost} onClick={onClose}>
            Close
          </button>
        </div>
        {error && <Notice kind="err">{error}</Notice>}
        {!d || !e ? (
          !error && <Loading />
        ) : (
          <div className="mt-3 space-y-4 text-sm">
            <div>
              <p className="text-2xl font-semibold text-white">
                <Money amount={e.amount} currency={e.currency} />
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <StatusBadge e={e} />
                <Badge>{PROVIDER_LABEL[e.provider]}</Badge>
              </div>
            </div>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-zinc-300">
              <Row k="What">{e.description}</Row>
              <Row k="Customer">
                {e.userId ? (
                  <Link className="text-cyan-300 hover:underline" href={customerHref(e.userId)}>
                    {e.email ?? e.userId}
                  </Link>
                ) : (
                  e.email ?? "Guest buyer"
                )}
                {e.name && <span className="text-zinc-500"> · {e.name}</span>}
              </Row>
              <Row k="Date">{fmtTime(e.at)}</Row>
              {e.periodStart && e.status !== "failed" && (
                <Row k="Period">
                  {day(e.periodStart)} to {day(e.periodEnd)}
                </Row>
              )}
              <Row k="Reference">
                <code className="break-all text-xs">{e.ref}</code>
              </Row>
              <Row k="Recorded by">
                {e.source === "espees-redirect-unverified"
                  ? "the buyer's browser returning from eSPees (not confirmed with eSPees)"
                  : e.source === "stripe-webhook"
                    ? "Stripe's signed webhook"
                    : e.source === "manual"
                      ? "an administrator (arranged directly)"
                      : e.source}
              </Row>
              {e.country && <Row k="Country">{e.country}</Row>}
              {e.failureReason && <Row k="Why it failed">{e.failureReason}</Row>}
              {d.account && e.kind === "plan" && (
                <Row k="Account now">
                  {d.account.exists ? `${d.account.plan ?? "free"}${d.account.planExpiresAt ? ` until ${day(d.account.planExpiresAt)}` : ""}` : "account deleted"}
                </Row>
              )}
            </dl>

            {e.status !== "failed" && (
              <div className="flex flex-wrap gap-2">
                <Link className={btn.ghost} href={invoiceHref(e.id)}>
                  {d.invoice ? `Invoice ${d.invoice.number}` : "Issue invoice"}
                </Link>
                <a className={btn.ghost} href={`/api/admin/billing/payments/${encodeURIComponent(e.id)}/invoice?format=pdf`}>
                  Download PDF
                </a>
              </div>
            )}

            {e.refunds.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Refunds</h3>
                <ul className="divide-y divide-white/5 rounded-lg border border-white/10">
                  {e.refunds.map((r) => (
                    <li key={r.id} className="px-3 py-2">
                      <div className="flex justify-between gap-2">
                        <span className="text-red-200">−{fmtMoney(r.amount, r.currency)}</span>
                        <span className="text-xs text-zinc-500">{fmtTime(r.at)}</span>
                      </div>
                      <p className="text-xs text-zinc-400">
                        {r.method === "stripe" ? `Through Stripe (${r.providerStatus ?? "sent"})` : "Made outside NeoConference and recorded"}
                        {r.providerRef ? ` · ${r.providerRef}` : ""} · by {r.byEmail}
                        {r.downgraded ? " · plan ended" : ""}
                      </p>
                      {r.reason && <p className="text-xs text-zinc-300">{r.reason}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {can("billing:refund") && d.refund.method && (
              <RefundForm
                key={e.refundedAmount}
                entry={e}
                refund={d.refund}
                onDone={(msg) => {
                  setN((x) => x + 1);
                  onChanged(msg);
                }}
              />
            )}

            {d.others.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Their other payments</h3>
                <ul className="divide-y divide-white/5 text-xs">
                  {d.others.slice(0, 10).map((o) => (
                    <li key={o.id} className="flex justify-between gap-2 py-1.5">
                      <span className="text-zinc-400">{day(o.at)}</span>
                      <span className="flex-1 truncate text-zinc-300">{o.description}</span>
                      <Money amount={o.amount} currency={o.currency} />
                      <StatusBadge e={o} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500">{k}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function RefundForm({ entry, refund, onDone }: { entry: Entry; refund: Detail["refund"]; onDone: (msg: string) => void }) {
  const { adminFetch } = useAdmin();
  const [amount, setAmount] = useState(String(refund.remaining));
  const [reason, setReason] = useState("");
  const [outsideRef, setOutsideRef] = useState("");
  const [downgrade, setDowngrade] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = Number(amount);
  const valid = useMemo(
    () => Number.isFinite(value) && value > 0 && value <= refund.remaining + 1e-9 && reason.trim() && (refund.method === "stripe" || outsideRef.trim()),
    [value, refund, reason, outsideRef],
  );
  const stripe = refund.method === "stripe";

  const send = async () => {
    setAsking(false);
    setBusy(true);
    setError(null);
    const r = await adminFetch<{ downgraded: boolean }>(`/api/admin/billing/payments/${encodeURIComponent(entry.id)}/refund`, {
      method: "POST",
      json: { amount: value, currency: refund.currency, reason, outsideRef: stripe ? undefined : outsideRef, downgrade },
    });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? "The refund did not go through.");
    onDone(`${fmtMoney(value, refund.currency)} ${stripe ? "refunded through Stripe" : "recorded as refunded"}${r.data.downgraded ? "; the plan was ended" : ""}.`);
  };

  return (
    <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-3">
      <h3 className="text-sm font-semibold text-white">{stripe ? "Refund through Stripe" : "Record a refund made outside NeoConference"}</h3>
      <p className="mt-1 text-xs text-zinc-400">
        {stripe
          ? "The money goes back to the card the buyer paid with, through Stripe. NeoConference never sees the card."
          : entry.provider === "espees"
            ? "eSPees has no refund API NeoConference can call. Send the Espees back from the merchant wallet yourself first, then record it here with that transfer's reference. Nothing is sent from here."
            : "This payment was arranged directly. Return the money the way it was paid, then record it here."}
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-zinc-400">
          Amount ({refund.currency}) — up to {fmtMoney(refund.remaining, refund.currency)}
          <input inputMode="decimal" value={amount} onChange={(ev) => setAmount(ev.target.value)} className={`${field} mt-1`} />
        </label>
        {!stripe && (
          <label className="text-xs text-zinc-400">
            Transfer reference
            <input value={outsideRef} onChange={(ev) => setOutsideRef(ev.target.value)} placeholder="eSPees transaction id" className={`${field} mt-1`} maxLength={120} />
          </label>
        )}
        <label className="text-xs text-zinc-400 sm:col-span-2">
          Reason
          <input value={reason} onChange={(ev) => setReason(ev.target.value)} className={`${field} mt-1`} maxLength={300} />
        </label>
      </div>
      {entry.kind === "plan" && (
        <label className={`mt-2 flex items-start gap-2 text-xs ${refund.canEndPlan ? "text-zinc-300" : "text-zinc-500"}`}>
          <input type="checkbox" className="mt-0.5" checked={downgrade} disabled={!refund.canEndPlan} onChange={(ev) => setDowngrade(ev.target.checked)} />
          <span>
            Also end their plan now (move the account to Free).
            {!refund.canEndPlan && " Not available: this is the platform owner's account, whose plan cannot be changed."}
          </span>
        </label>
      )}
      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
      <div className="mt-3 flex justify-end">
        <button type="button" className={btn.danger} disabled={!valid || busy} onClick={() => setAsking(true)}>
          {busy ? "Working…" : stripe ? "Refund…" : "Record refund…"}
        </button>
      </div>
      {asking && (
        <Confirm
          danger
          title={stripe ? `Refund ${fmtMoney(value, refund.currency)}?` : `Record a refund of ${fmtMoney(value, refund.currency)}?`}
          body={
            <>
              {stripe ? "Stripe sends" : "You confirm you have returned"} <b className="text-white">{fmtMoney(value, refund.currency)}</b> to{" "}
              {entry.email ?? entry.userId ?? "the buyer"} for &ldquo;{entry.description}&rdquo;.
              {downgrade && " Their plan ends now."} This cannot be undone from here.
            </>
          }
          confirmLabel={stripe ? `Refund ${fmtMoney(value, refund.currency)}` : "Record refund"}
          onConfirm={send}
          onCancel={() => setAsking(false)}
        />
      )}
    </div>
  );
}
