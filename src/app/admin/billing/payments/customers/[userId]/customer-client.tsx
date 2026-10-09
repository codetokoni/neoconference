"use client";

// One account's billing history: what they paid (per currency), refunds,
// checkouts they started, and the reminders sent to them.

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Time, useAdmin } from "../../../../AdminApi";
import { Badge, EmptyLine, Loading, Notice, PageHeader, Pager, Panel, StatTile, useClientTable } from "../../../../ui";
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
const PAGE = 25;

export default function CustomerClient({ userId }: { userId: string }) {
  const { adminFetch } = useAdmin();
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const payments = useClientTable(d?.payments, (e) => e.at, { key: "at", dir: "desc", pageSize: PAGE });
  const checkouts = useClientTable(d?.checkouts, (c) => c.createdAt, { key: "at", dir: "desc", pageSize: PAGE });
  const reminders = useClientTable(d?.reminders, (r) => r.at, { key: "at", dir: "desc", pageSize: PAGE });

  const load = useCallback(async () => {
    setError(null);
    const r = await adminFetch<Data>(`/api/admin/billing/customers/${encodeURIComponent(userId)}`);
    if (r.ok) setD(r.data);
    else setError(r.data.message ?? "Could not load this account.");
  }, [adminFetch, userId]);
  useEffect(() => {
    load();
  }, [load]);

  const listHref = (extra: Record<string, string> = {}) => `/admin/billing/payments?${new URLSearchParams({ user: userId, ...extra })}`;

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
      {error && (
        <Notice kind="err" onRetry={load}>
          {error}
        </Notice>
      )}
      {!d ? (
        !error && <Loading />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <StatTile label="Paid in total" value={<Totals totals={d.totals.paid} />} href={listHref()} hint="Open their payments" />
            <StatTile label="Refunded" value={<Totals totals={d.totals.refunded} />} href={listHref({ status: "refunds" })} hint="Open their refunded payments" />
          </div>

          <Section title="Payments" count={payments.total}>
            {d.payments.length === 0 ? (
              <EmptyLine>No payments.</EmptyLine>
            ) : (
              <ul className="divide-y divide-white/5 text-sm">
                {payments.visible.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <Time ts={e.at} className="w-44 text-xs text-zinc-400" />
                    <Link href={`/admin/billing/payments?open=${encodeURIComponent(e.id)}`} className="min-w-0 flex-1 truncate text-cyan-200 hover:underline">
                      {e.description}
                    </Link>
                    <span className="text-xs text-zinc-400">{PROVIDER_LABEL[e.provider]}</span>
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
            {payments.total > PAGE && <Pager page={payments.page} pageSize={payments.pageSize} total={payments.total} onPage={payments.setPage} noun="payment" />}
          </Section>

          <Section title="Checkouts started" count={checkouts.total}>
            {d.checkouts.length === 0 ? (
              <EmptyLine>None recorded. Checkouts are recorded from this release on.</EmptyLine>
            ) : (
              <ul className="divide-y divide-white/5 text-sm">
                {checkouts.visible.map((c) => (
                  <li key={c.nonce} className="flex flex-wrap items-center gap-3 py-2">
                    <Time ts={c.createdAt} className="w-44 text-xs text-zinc-400" />
                    <span className="flex-1 text-zinc-200">
                      {c.plan}, {c.billingCycle}
                    </span>
                    {c.amount != null && <Money amount={c.amount} currency={c.currency} />}
                    <Badge tone={STATE[c.state] ?? "zinc"}>{c.state.replace("_", " ")}</Badge>
                  </li>
                ))}
              </ul>
            )}
            {checkouts.total > PAGE && <Pager page={checkouts.page} pageSize={checkouts.pageSize} total={checkouts.total} onPage={checkouts.setPage} noun="checkout" />}
          </Section>

          <Section title="Reminders sent" count={reminders.total}>
            {d.reminders.length === 0 ? (
              <EmptyLine>No billing reminders.</EmptyLine>
            ) : (
              <ul className="divide-y divide-white/5 text-sm">
                {reminders.visible.map((r, i) => (
                  <li key={`${r.at}-${i}`} className="flex flex-wrap gap-3 py-2">
                    <Time ts={r.at} className="w-44 text-xs text-zinc-400" />
                    <span className="text-zinc-300">{r.kind}</span>
                    <Badge tone={r.outcome === "sent" ? "green" : r.outcome === "failed" ? "red" : "zinc"}>{r.outcome}</Badge>
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{r.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            {reminders.total > PAGE && <Pager page={reminders.page} pageSize={reminders.pageSize} total={reminders.total} onPage={reminders.setPage} noun="reminder" />}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <Panel>
      <h2 className="mb-2 text-sm font-semibold text-white">
        {title}
        {count > 0 && <span className="ml-1.5 text-xs font-normal text-zinc-400">({count})</span>}
      </h2>
      {children}
    </Panel>
  );
}
