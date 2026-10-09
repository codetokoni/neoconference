"use client";

// Payments: every payment the platform has taken (eSPees plans, manual
// grants, Stripe ticket sales), filterable and searchable, with totals per
// currency, invoices, refunds and exports.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Time, fmtMoney, fmtNumber, fmtTime, useAdmin, zoneLabel } from "../../AdminApi";
import { Badge, Confirm, Dialog, Empty, FilterBar, Labeled, Loading, Notice, PageHeader, Pager, Panel, StatTile, btn, field, useUrlFilters } from "../../ui";
import type { ByCurrency } from "@/lib/finance/money";
import { BillingNav, Money, PROVIDER_LABEL, StatusBadge, Totals, apiTime, customerHref, day, dayInput, invoiceHref, isInstantRange, type Entry } from "../shared";

const TIER_IDS = ["free", "starter", "pro", "business", "enterprise"];

type Page = {
  items: Entry[];
  total: number;
  totals: { paid: ByCurrency; refunded: ByCurrency; failed: ByCurrency };
  indexed: number;
};

const EMPTY = { from: "", to: "", status: "", provider: "", plan: "", user: "", q: "" };
type Filters = typeof EMPTY;

export default function PaymentsClient() {
  const { can, adminFetch, adminDownload } = useAdmin();
  // Filters live in the URL (same names as the API), so a link such as
  // ?status=failed&from=…&to=… or ?q=… opens filtered, and ?open=<id> opens
  // one payment.
  const { value: applied, set: setApplied, reset, active } = useUrlFilters(EMPTY);
  const { value: openParam, set: setOpenParam } = useUrlFilters({ open: "" });
  const open = openParam.open || null;
  const appliedKey = JSON.stringify(applied);
  const [draft, setDraft] = useState<Filters>(applied);
  // Follow the address bar when it changes from outside the form (a tile, Clear, back/forward).
  useEffect(() => setDraft(JSON.parse(appliedKey) as Filters), [appliedKey]);
  const [limit, setLimit] = useState(50);
  // The page belongs to one set of filters: new filters start at the first page without a second request.
  const [paging, setPaging] = useState({ key: appliedKey, offset: 0 });
  const offset = paging.key === appliedKey ? paging.offset : 0;
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [confirmBackfill, setConfirmBackfill] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  // Catalog plans beyond the four tiers, for the Plan filter (only for a role that can read the catalog).
  const [catalog, setCatalog] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!can("plans:read")) return;
    adminFetch<{ plans: { id: string; name: string }[] }>("/api/admin/plans").then((r) => {
      if (r.ok) setCatalog((r.data.plans ?? []).filter((p) => !TIER_IDS.includes(p.id)));
    });
  }, [can, adminFetch]);
  const [exportError, setExportError] = useState<string | null>(null);

  const query = useMemo(() => {
    const f = JSON.parse(appliedKey) as Filters;
    return (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...f, ...extra })) {
        const sent = k === "from" ? apiTime(v, false) : k === "to" ? apiTime(v, true) : v;
        if (sent) p.set(k, sent);
      }
      return p.toString();
    };
  }, [appliedKey]);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    adminFetch<Page>(`/api/admin/billing/payments?${query({ limit: String(limit), offset: String(offset) })}`).then((r) => {
      if (!live) return;
      if (r.ok) setData(r.data);
      else setError(r.data.message ?? "Could not load payments.");
    });
    return () => {
      live = false;
    };
  }, [adminFetch, query, offset, limit, reload]);

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });
  const setStatus = (s: string) => setApplied({ status: applied.status === s ? "" : s });

  const backfill = async () => {
    setNotice(null);
    const r = await adminFetch<{ result: { planPayments: number; ticketSales: number; stripe: string; stripeError?: string; indexSize: number } }>("/api/admin/billing/backfill", { method: "POST" });
    setConfirmBackfill(false);
    if (!r.ok) return setError(r.data.message ?? "The backfill failed.");
    const x = r.data.result;
    setNotice(
      `Listed ${x.planPayments} plan payment${x.planPayments === 1 ? "" : "s"} and ${x.ticketSales} Stripe ticket sale${x.ticketSales === 1 ? "" : "s"}; ${x.indexSize} in the index.` +
        (x.stripe === "not_configured" ? " Stripe is not configured, so no ticket sales were read from it." : x.stripe === "failed" ? ` Reading Stripe failed: ${x.stripeError}` : ""),
    );
    setReload((n) => n + 1);
  };

  const download = async (label: string, url: string) => {
    setExporting(label);
    setExportError(null);
    const r = await adminDownload(url);
    setExporting(null);
    if (!r.ok && r.data.error !== "cancelled") setExportError(`${label}: ${r.data.message ?? "the export failed."}`);
  };

  return (
    <div>
      <PageHeader
        title="Billing"
        sub="Every payment, with amounts in the currency they were paid in. Totals are per currency and never added across currencies."
        actions={
          can("billing:settings") && (
            <button
              type="button"
              className={btn.ghost}
              onClick={() => {
                setNotice(null);
                setConfirmBackfill(true);
              }}
              title="List payments made before this page existed"
            >
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
            setApplied(draft);
          }}
        >
          <FilterBar active={active} onClear={reset}>
            <Labeled label="Search" className="w-full sm:w-56">
              <input type="search" placeholder="Reference, invoice, email, name" value={draft.q} onChange={set("q")} className={field} />
            </Labeled>
            <Labeled label="Customer" className="w-full sm:w-56">
              <input placeholder="Email or user id" value={draft.user} onChange={set("user")} className={field} />
            </Labeled>
            <Labeled label="Status">
              <select value={draft.status} onChange={set("status")} className={`${field} sm:w-40`}>
                <option value="">Any status</option>
                <option value="paid">Paid</option>
                <option value="partially_refunded">Partly refunded</option>
                <option value="refunded">Refunded</option>
                <option value="refunds">Any refund</option>
                <option value="failed">Failed</option>
              </select>
            </Labeled>
            <Labeled label="Provider">
              <select value={draft.provider} onChange={set("provider")} className={`${field} sm:w-36`}>
                <option value="">Any provider</option>
                <option value="espees">eSPees</option>
                <option value="stripe">Stripe</option>
                <option value="manual">Manual</option>
              </select>
            </Labeled>
            <Labeled label="Plan">
              <select value={draft.plan} onChange={set("plan")} className={`${field} sm:w-44`}>
                <option value="">Any plan or ticket</option>
                <option value="starter">Starter</option>
                <option value="pro">Pro</option>
                <option value="business">Business</option>
                <option value="enterprise">Enterprise</option>
                {catalog.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option value="ticket">Event tickets</option>
              </select>
            </Labeled>
            <Labeled label={`From (${zoneLabel()})`}>
              <input type="date" value={dayInput(draft.from)} onChange={set("from")} className={`${field} sm:w-40`} />
            </Labeled>
            <Labeled label={`To (${zoneLabel()})`}>
              <input type="date" value={dayInput(draft.to)} onChange={set("to")} className={`${field} sm:w-40`} />
            </Labeled>
            <button type="submit" className={btn.primary}>
              Apply
            </button>
          </FilterBar>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-zinc-400">
            {isInstantRange(applied.from, applied.to) && `Period from the Overview: ${fmtTime(Number(applied.from))} – ${fmtTime(Number(applied.to))}. `}
            Days and times are on the admin clock ({zoneLabel()}).
          </p>
          {can("reports:export") && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              <span className="self-center text-zinc-400">Export what is filtered</span>
              {(
                [
                  ["payments", "csv", "Payments CSV"],
                  ["payments", "xlsx", "Payments Excel"],
                  ["refunds", "csv", "Refunds CSV"],
                  ["refunds", "xlsx", "Refunds Excel"],
                ] as const
              ).map(([type, format, label]) => (
                <button key={label} type="button" className={btn.ghost} disabled={!!exporting} onClick={() => download(label, `/api/admin/billing/export?${query({ type, format })}`)}>
                  {exporting === label ? "Preparing…" : label}
                </button>
              ))}
            </div>
          )}
        </div>
        {exportError && (
          <div className="mt-3">
            <Notice kind="err" onClose={() => setExportError(null)}>
              {exportError}
            </Notice>
          </div>
        )}
      </Panel>

      {error && (
        <Notice kind="err" onRetry={() => setReload((n) => n + 1)}>
          {error}
        </Notice>
      )}
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <StatTile
              label={`Received (${fmtNumber(data.total)} payment${data.total === 1 ? "" : "s"} match)`}
              value={<Totals totals={data.totals.paid} />}
              hint={applied.status ? "Show every status" : "Every status shown"}
              active={!applied.status}
              onClick={() => setApplied({ status: "" })}
            />
            <StatTile
              label="Refunded"
              value={<Totals totals={data.totals.refunded} />}
              hint="Show payments with a refund"
              active={applied.status === "refunds"}
              onClick={() => setStatus("refunds")}
            />
            <StatTile
              label="Failed (not taken)"
              value={<Totals totals={data.totals.failed} />}
              hint="Show failed payments"
              active={applied.status === "failed"}
              tone={applied.status === "failed" ? "red" : undefined}
              onClick={() => setStatus("failed")}
            />
          </div>
          {data.items.length === 0 ? (
            <Empty>
              No payments match.
              {data.indexed === 0 && can("billing:settings") && " If payments were taken before this page existed, use Rebuild index to list them."}
            </Empty>
          ) : (
            <>
              <p className="mb-2 text-xs text-zinc-400">Newest first. Open a payment for its details, invoice and refunds.</p>
              <Panel className="overflow-x-auto p-0">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-400">
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
                      // The whole row opens the payment for the mouse; the button in "What" does it for the keyboard.
                      <tr key={e.id} className="cursor-pointer border-t border-white/5 hover:bg-white/[0.03]" onClick={() => setOpenParam({ open: e.id })}>
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400">
                          <Time ts={e.at} />
                        </td>
                        <td className="max-w-[200px] truncate px-3 py-2 text-zinc-200">{e.email ?? e.name ?? e.userId ?? "Guest"}</td>
                        <td className="max-w-[240px] truncate px-3 py-2">
                          <button
                            type="button"
                            className="max-w-full truncate text-left text-cyan-200 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setOpenParam({ open: e.id });
                            }}
                          >
                            {e.description}
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right text-zinc-100">
                          <Money amount={e.amount} currency={e.currency} />
                          {e.refundedAmount > 0 && e.status !== "refunded" && <div className="text-[11px] text-red-300">−{fmtMoney(e.refundedAmount, e.currency)}</div>}
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
              </Panel>
              <Pager
                page={Math.floor(offset / limit) + 1}
                pageSize={limit}
                total={data.total}
                onPage={(p) => setPaging({ key: appliedKey, offset: (p - 1) * limit })}
                onPageSize={(n) => {
                  setLimit(n);
                  setPaging({ key: appliedKey, offset: 0 });
                }}
                noun="payment"
              />
              <p className="mt-1 text-xs text-zinc-400">{fmtNumber(data.indexed)} payments in the index.</p>
            </>
          )}
        </>
      )}

      {open && (
        <PaymentDetail
          id={open}
          onClose={() => setOpenParam({ open: "" })}
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

type Detail = {
  entry: Entry;
  invoice: { number: string } | null;
  refund: { method: "stripe" | "outside" | null; remaining: number; currency: string; canEndPlan: boolean };
  account: { plan: string | null; planExpiresAt: number | null; exists: boolean } | null;
  others: Entry[];
};

/** Other payments shown in the dialog; the customer page has them all. */
const OTHERS_SHOWN = 10;

function PaymentDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (msg: string) => void }) {
  const { can, adminFetch, adminDownload } = useAdmin();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const [pdf, setPdf] = useState<"idle" | "busy">("idle");
  const [pdfError, setPdfError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    adminFetch<Detail>(`/api/admin/billing/payments/${encodeURIComponent(id)}`).then((r) => {
      if (!live) return;
      if (r.ok) setD(r.data);
      else setError(r.data.message ?? "Could not load the payment.");
    });
    return () => {
      live = false;
    };
  }, [adminFetch, id, n]);

  const downloadPdf = async (entryId: string) => {
    setPdf("busy");
    setPdfError(null);
    const r = await adminDownload(`/api/admin/billing/payments/${encodeURIComponent(entryId)}/invoice?format=pdf`);
    setPdf("idle");
    if (!r.ok && r.data.error !== "cancelled") setPdfError(r.data.message ?? "The PDF could not be downloaded.");
  };

  const e = d?.entry;
  return (
    <Dialog title="Payment" onClose={onClose} wide>
      <div className="mt-1 flex justify-end">
        <button type="button" className={btn.ghost} onClick={onClose}>
          Close
        </button>
      </div>
      {error && (
        <Notice kind="err" onRetry={() => setN((x) => x + 1)}>
          {error}
        </Notice>
      )}
      {!d || !e ? (
        !error && <Loading />
      ) : (
        <div className="mt-1 space-y-4 text-sm">
          <div>
            <p className="text-2xl font-semibold text-white">
              <Money amount={e.amount} currency={e.currency} />
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <StatusBadge e={e} />
              <Badge>{PROVIDER_LABEL[e.provider]}</Badge>
            </div>
          </div>
          <dl className="grid grid-cols-1 gap-x-3 gap-y-1.5 text-zinc-300 sm:grid-cols-[8rem_1fr]">
            <Row k="What">{e.description}</Row>
            <Row k="Customer">
              {e.userId ? (
                <Link className="break-all text-cyan-300 hover:underline" href={customerHref(e.userId)}>
                  {e.email ?? e.userId}
                </Link>
              ) : (
                e.email ?? "Guest buyer"
              )}
              {e.name && <span className="text-zinc-400"> · {e.name}</span>}
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
              <Row k="Account now">{d.account.exists ? `${d.account.plan ?? "free"}${d.account.planExpiresAt ? ` until ${day(d.account.planExpiresAt)}` : ""}` : "account deleted"}</Row>
            )}
          </dl>

          {e.status !== "failed" && (
            <div className="flex flex-wrap gap-2">
              <Link className={btn.ghost} href={invoiceHref(e.id)}>
                {d.invoice ? `Invoice ${d.invoice.number}` : "Issue invoice"}
              </Link>
              <button type="button" className={btn.ghost} disabled={pdf === "busy"} onClick={() => downloadPdf(e.id)}>
                {pdf === "busy" ? "Preparing PDF…" : "Download PDF"}
              </button>
            </div>
          )}
          {pdfError && (
            <Notice kind="err" onClose={() => setPdfError(null)}>
              {pdfError}
            </Notice>
          )}

          {e.refunds.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">Refunds</h3>
              <ul className="divide-y divide-white/5 rounded-lg border border-white/10">
                {e.refunds.map((r) => (
                  <li key={r.id} className="px-3 py-2">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="text-red-200">−{fmtMoney(r.amount, r.currency)}</span>
                      <Time ts={r.at} className="text-xs text-zinc-400" />
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
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">Their other payments</h3>
              <ul className="divide-y divide-white/5 text-xs">
                {d.others.slice(0, OTHERS_SHOWN).map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span className="text-zinc-400">
                      <Time ts={o.at} mode="date" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-zinc-300">{o.description}</span>
                    <Money amount={o.amount} currency={o.currency} />
                    <StatusBadge e={o} />
                  </li>
                ))}
              </ul>
              {d.others.length > OTHERS_SHOWN && (
                <p className="mt-1 text-xs text-zinc-400">
                  Showing {OTHERS_SHOWN} of {fmtNumber(d.others.length)}.{" "}
                  {e.userId && (
                    <Link className="text-cyan-300 hover:underline" href={customerHref(e.userId)}>
                      See all on the customer page
                    </Link>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-zinc-400">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
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

  // The confirmation stays open, showing that it is working, until the server answers.
  const send = async () => {
    setBusy(true);
    setError(null);
    const r = await adminFetch<{ downgraded: boolean }>(`/api/admin/billing/payments/${encodeURIComponent(entry.id)}/refund`, {
      method: "POST",
      json: { amount: value, currency: refund.currency, reason, outsideRef: stripe ? undefined : outsideRef, downgrade },
    });
    setBusy(false);
    setAsking(false);
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
        <label className={`mt-2 flex items-start gap-2 text-xs ${refund.canEndPlan ? "text-zinc-300" : "text-zinc-400"}`}>
          <input type="checkbox" className="mt-0.5" checked={downgrade} disabled={!refund.canEndPlan} onChange={(ev) => setDowngrade(ev.target.checked)} />
          <span>
            Also end their plan now (move the account to Free).
            {!refund.canEndPlan && " Not available: this is the platform owner's account, whose plan cannot be changed."}
          </span>
        </label>
      )}
      {error && (
        <div className="mt-2">
          <Notice kind="err" onClose={() => setError(null)}>
            {error}
          </Notice>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {!valid && !busy && <span className="text-xs text-zinc-400">{stripe ? "Enter an amount and a reason." : "Enter an amount, the transfer reference and a reason."}</span>}
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
              {stripe ? "Stripe sends" : "You confirm you have returned"} <b className="text-white">{fmtMoney(value, refund.currency)}</b> to {entry.email ?? entry.userId ?? "the buyer"} for &ldquo;
              {entry.description}&rdquo;.
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
