"use client";

// One account's billing history: what they paid (per currency), refunds,
// checkouts they started, and the reminders sent to them.

import Link from "next/link";
import { useEffect, useState } from "react";
import { fmtTime, useAdmin } from "../../../../AdminApi";
import { Badge, Empty, Loading, Notice, PageHeader, Panel } from "../../../../ui";
import type { ByCurrency } from "@/lib/finance/money";
import { BillingNav, Money, PROVIDER_LABEL, StatusBadge, Totals, day, invoiceHref, type Entry } from "../../../shared";

type Data = {
  user: { userId: string; email: string | null; name: string | null; exists: boolean; plan: string | null; planExpiresAt: number | null; isOwner: boolean };
  totals: { paid: ByCurrency; refunded: ByCurrency };
  payments: Entry[];
  checkouts: { nonce: string; plan: string; billingCycle: string; amount: number | null; currency: string; createdAt: number; state: string; paymentRef?: string }[];
  reminders: { at: number; kind: string; outcome: string; detail?: string }[];
};

const STATE: Record<string, "green" | "amber" | "red" | "zinc" | "cyan"> = { paid: "green", abandoned: "amber", failed: "red", in_progress: "cyan" };

export default function CustomerClient({ userId }: { userId: string }) {
  const { adminFetch } = useAdmin();
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminFetch<Data>(`/api/admin/billing/customers/${encodeURIComponent(userId)}`).then((r) => {
      if (r.ok) setD(r.data);
      else setError(r.data.message ?? "Could not load this account.");
    });
  }, [adminFetch, userId]);

  return (
    <div>
      <PageHeader
        title={d?.user.email ?? userId}
        sub={
          d && (
            <>
              {d.user.name && <>{d.user.name} · </>}
              {d.user.exists ? (
                <>
                  Plan now: <b className="text-zinc-200">{d.user.plan ?? "free"}</b>
                  {d.user.planExpiresAt ? ` until ${day(d.user.planExpiresAt)}` : ""}
                </>
              ) : (
                "This account no longer exists."
              )}
              {d.user.isOwner && (
                <>
                  {" "}
                  · <Badge tone="amber">Platform owner</Badge>
                </>
              )}
            </>
          )
        }
      />
      <BillingNav active="payments" />
      <p className="mb-3 text-sm">
        <Link href="/admin/billing/payments" className="text-cyan-300 hover:underline">
          ← All payments
        </Link>
      </p>
      {error && <Notice kind="err">{error}</Notice>}
      {!d ? (
        !error && <Loading />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Panel>
              <p className="text-xs text-zinc-500">Paid in total</p>
              <div className="mt-1 text-lg font-semibold text-white">
                <Totals totals={d.totals.paid} />
              </div>
            </Panel>
            <Panel>
              <p className="text-xs text-zinc-500">Refunded</p>
              <div className="mt-1 text-lg font-semibold text-white">
                <Totals totals={d.totals.refunded} />
              </div>
            </Panel>
          </div>

          <Panel>
            <h2 className="mb-2 text-sm font-semibold text-white">Payments</h2>
            {d.payments.length === 0 ? (
              <Empty>No payments.</Empty>
            ) : (
              <ul className="divide-y divide-white/5 text-sm">
                {d.payments.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="w-40 text-xs text-zinc-400">{fmtTime(e.at)}</span>
                    <span className="min-w-0 flex-1 truncate text-zinc-200">{e.description}</span>
                    <span className="text-xs text-zinc-500">{PROVIDER_LABEL[e.provider]}</span>
                    <Money amount={e.amount} currency={e.currency} className="text-zinc-100" />
                    <StatusBadge e={e} />
                    {e.status !== "failed" && (
                      <Link className="text-xs text-cyan-300 hover:underline" href={invoiceHref(e.id)}>
                        {e.invoiceNumber ?? "Invoice"}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel>
            <h2 className="mb-2 text-sm font-semibold text-white">Checkouts started</h2>
            {d.checkouts.length === 0 ? (
              <Empty>None recorded. Checkouts are recorded from this release on.</Empty>
            ) : (
              <ul className="divide-y divide-white/5 text-sm">
                {d.checkouts.map((c) => (
                  <li key={c.nonce} className="flex flex-wrap items-center gap-3 py-2">
                    <span className="w-40 text-xs text-zinc-400">{fmtTime(c.createdAt)}</span>
                    <span className="flex-1 text-zinc-200">
                      {c.plan}, {c.billingCycle}
                    </span>
                    {c.amount != null && <Money amount={c.amount} currency={c.currency} />}
                    <Badge tone={STATE[c.state] ?? "zinc"}>{c.state.replace("_", " ")}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel>
            <h2 className="mb-2 text-sm font-semibold text-white">Reminders sent</h2>
            {d.reminders.length === 0 ? (
              <Empty>No billing reminders.</Empty>
            ) : (
              <ul className="divide-y divide-white/5 text-sm">
                {d.reminders.map((r, i) => (
                  <li key={i} className="flex flex-wrap gap-3 py-2">
                    <span className="w-40 text-xs text-zinc-400">{fmtTime(r.at)}</span>
                    <span className="text-zinc-300">{r.kind}</span>
                    <Badge tone={r.outcome === "sent" ? "green" : r.outcome === "failed" ? "red" : "zinc"}>{r.outcome}</Badge>
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{r.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
