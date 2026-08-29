// src/app/dashboard/billing/page.tsx
//
// Task 2 of docs/BILLING-HANDOFF.md. Server component that renders the
// caller's current plan + payment history from Clerk metadata and the
// paymentsStore introduced in Task 1.
//
// - Current plan card: plan name, renewal date, days remaining, change
//   link to /pricing.
// - Payment history table: date, plan, cycle, amount (ESP), reference,
//   status. Invoice links are stubbed with a title tooltip until Task 3
//   (invoice PDF route) lands — anchoring the column now avoids a
//   layout change later.
// - Free-plan empty state that pitches the upgrade rather than showing
//   an empty table.
// - Admin-only "unverified" chip on redirect-granted payments so the
//   operator can see which grants haven't been reconciled with eSpees.
//   Regular users see just "paid".

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/roles";
import {
  readPlanFromMetadata,
  getPlanLimits,
  type Plan,
} from "@/lib/plan";
import { listUserPayments, type PaymentRecord } from "@/lib/paymentsStore";

export const metadata: Metadata = {
  title: "Billing — NeoConference",
};

export const dynamic = "force-dynamic";

const PLAN_LABELS: Record<Plan, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
};

const CYCLE_LABELS: Record<string, string> = {
  monthly: "Monthly",
  annual: "Annual",
};

function formatDate(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function daysUntil(ms: number | null | undefined): number | null {
  if (!ms || !Number.isFinite(ms)) return null;
  const diffMs = ms - Date.now();
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

function readPlanExpiresAt(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).planExpiresAt;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export default async function BillingPage() {
  const { userId } = await auth();
  if (!userId) {
    redirect("/sign-in?redirect_url=/dashboard/billing");
  }

  const user = await currentUser();
  const emails = (user?.emailAddresses || []).map((e) =>
    e.emailAddress.toLowerCase(),
  );
  const viewerIsAdmin = emails.some((e) => isAdmin(e));

  const plan = readPlanFromMetadata(user?.publicMetadata);
  const planExpiresAt = readPlanExpiresAt(user?.publicMetadata);
  const remainingDays = daysUntil(planExpiresAt);
  const limits = getPlanLimits(plan);

  const payments = await listUserPayments(userId!, 50);

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10">
      <header className="mb-8">
        <div className="text-xs text-zinc-500 mb-2">
          <Link href="/dashboard" className="hover:text-zinc-300">
            Dashboard
          </Link>
          <span className="mx-1.5">/</span>
          <span>Billing</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-cyan-100">
          Billing
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Your current plan and payment history.
        </p>
      </header>

      <PlanCard
        plan={plan}
        planExpiresAt={planExpiresAt}
        remainingDays={remainingDays}
        limits={limits}
      />

      <section className="mt-10">
        <h2 className="text-lg font-medium text-cyan-100 mb-3">
          Payment history
        </h2>
        {payments.length === 0 ? (
          <EmptyHistory plan={plan} />
        ) : (
          <PaymentHistoryTable payments={payments} viewerIsAdmin={viewerIsAdmin} />
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Plan card                                                           */
/* ------------------------------------------------------------------ */

function PlanCard({
  plan,
  planExpiresAt,
  remainingDays,
  limits,
}: {
  plan: Plan;
  planExpiresAt: number | null;
  remainingDays: number | null;
  limits: ReturnType<typeof getPlanLimits>;
}) {
  const isFree = plan === "free";
  const isEnterprise = plan === "enterprise";
  const ctaLabel = isFree ? "Choose a plan" : "Change plan";

  const renewalLabel = (() => {
    if (isFree) return "No expiry";
    if (!planExpiresAt) return "No expiry (permanent)";
    return formatDate(planExpiresAt);
  })();

  const remainingLabel = (() => {
    if (isFree || !planExpiresAt) return null;
    if (remainingDays === 0) return "Expires today";
    if (remainingDays === 1) return "1 day left";
    return remainingDays + " days left";
  })();

  return (
    <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 backdrop-blur">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1">
            Current plan
          </div>
          <div className="text-2xl font-semibold text-white">
            {PLAN_LABELS[plan]}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-400">
            <span>
              <span className="text-zinc-500">Renews:</span> {renewalLabel}
            </span>
            {remainingLabel && (
              <span
                className={
                  remainingDays !== null && remainingDays <= 7
                    ? "text-amber-300"
                    : "text-zinc-400"
                }
              >
                {remainingLabel}
              </span>
            )}
          </div>
        </div>
        <Link
          href={isEnterprise ? "mailto:info@neoconference.app" : "/pricing"}
          className="inline-flex items-center justify-center rounded-lg border border-cyan-300/40 bg-cyan-500/15 hover:bg-cyan-500/25 px-4 py-2 text-sm font-medium text-cyan-100 transition"
        >
          {isEnterprise ? "Contact us" : ctaLabel}
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <LimitStat
          label="Meeting length"
          value={limits.meetingMinutes === 0 ? "Unlimited" : limits.meetingMinutes + " min"}
        />
        <LimitStat
          label="Participants"
          value={limits.maxParticipants === 0 ? "Unlimited" : String(limits.maxParticipants)}
        />
        <LimitStat
          label="Recording"
          value={
            limits.recording
              ? limits.recordingHoursPerMonth === 0
                ? "Unlimited"
                : limits.recordingHoursPerMonth + " hrs/mo"
              : "Not included"
          }
        />
        <LimitStat label="Breakouts" value={limits.breakouts ? "Included" : "Not included"} />
      </div>
    </section>
  );
}

function LimitStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">
        {label}
      </div>
      <div className="text-sm text-zinc-200">{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Payment history                                                     */
/* ------------------------------------------------------------------ */

function PaymentHistoryTable({
  payments,
  viewerIsAdmin,
}: {
  payments: PaymentRecord[];
  viewerIsAdmin: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="min-w-full text-sm">
        <thead className="bg-white/[0.03]">
          <tr className="text-left text-xs uppercase tracking-wider text-zinc-500">
            <th className="px-4 py-3 font-medium">Date</th>
            <th className="px-4 py-3 font-medium">Plan</th>
            <th className="px-4 py-3 font-medium">Cycle</th>
            <th className="px-4 py-3 font-medium text-right">Amount</th>
            <th className="px-4 py-3 font-medium">Reference</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium text-right">Invoice</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <PaymentRow key={p.paymentRef} p={p} viewerIsAdmin={viewerIsAdmin} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaymentRow({
  p,
  viewerIsAdmin,
}: {
  p: PaymentRecord;
  viewerIsAdmin: boolean;
}) {
  // Redirect grants are "assumed paid" pending an eSpees reconciliation.
  // Only surface that distinction to admins — end users see plain "Paid".
  const showUnverified =
    viewerIsAdmin && p.status === "paid" && p.source === "espees-redirect-unverified";

  const statusChip = (() => {
    if (p.status === "refunded") {
      return { label: "Refunded", className: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" };
    }
    if (p.status === "failed") {
      return { label: "Failed", className: "bg-rose-500/15 text-rose-300 border-rose-500/30" };
    }
    if (showUnverified) {
      return {
        label: "Paid · unverified",
        className: "bg-amber-500/15 text-amber-200 border-amber-500/30",
      };
    }
    return { label: "Paid", className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" };
  })();

  return (
    <tr className="border-t border-white/5 text-zinc-200">
      <td className="px-4 py-3">{formatDate(p.paidAt)}</td>
      <td className="px-4 py-3">{PLAN_LABELS[p.plan]}</td>
      <td className="px-4 py-3">{CYCLE_LABELS[p.billingCycle] ?? p.billingCycle}</td>
      <td className="px-4 py-3 text-right tabular-nums">{p.amountEsp} ESP</td>
      <td className="px-4 py-3">
        <code className="text-xs text-zinc-400">{p.paymentRef}</code>
      </td>
      <td className="px-4 py-3">
        <span
          className={
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium " +
            statusChip.className
          }
        >
          {statusChip.label}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        {/* Invoice PDF endpoint arrives with Task 3. Anchoring the column
             now avoids a layout change later; the tooltip explains why
             the link isn't live yet. */}
        <span
          className="text-xs text-zinc-500"
          title="Invoice PDF endpoint is not yet available. Coming with Task 3 of the billing rollout."
        >
          Coming soon
        </span>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/*  Empty state                                                         */
/* ------------------------------------------------------------------ */

function EmptyHistory({ plan }: { plan: Plan }) {
  if (plan === "free") {
    return (
      <div className="rounded-2xl border border-cyan-300/20 bg-gradient-to-br from-cyan-500/[0.08] via-transparent to-fuchsia-500/[0.08] p-8 text-center">
        <div className="text-lg font-medium text-white">
          You&apos;re on the Free plan.
        </div>
        <p className="mt-2 text-sm text-zinc-400 max-w-md mx-auto">
          Upgrade to unlock longer meetings, larger rooms, cloud recording, and
          breakout rooms. Every paid tier is billed in Espees.
        </p>
        <div className="mt-5">
          <Link
            href="/pricing"
            className="inline-flex items-center justify-center rounded-lg border border-cyan-300/40 bg-cyan-500/15 hover:bg-cyan-500/25 px-5 py-2 text-sm font-medium text-cyan-100 transition"
          >
            See plans
          </Link>
        </div>
      </div>
    );
  }
  // Paid plans with no history are rare — a manual grant that pre-dates
  // Task 1's paymentsStore, or a user whose store record was wiped. Keep
  // the row honest rather than sell them another plan.
  return (
    <div className="rounded-xl border border-white/10 bg-zinc-950/60 p-6 text-sm text-zinc-400">
      No payment history is on file for this plan yet. If you paid recently,
      the record should appear within a minute — otherwise reach out to{" "}
      <a
        href="mailto:info@neoconference.app"
        className="text-cyan-300 hover:underline"
      >
        info@neoconference.app
      </a>
      .
    </div>
  );
}
