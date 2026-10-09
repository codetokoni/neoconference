// src/lib/admin/overview/links.ts
//
// Where each Overview figure leads: the list that holds the records behind
// it, filtered to the same period. Pure, so the route and the smoke test
// build the same links. Lists that filter by instant get epoch ms (the
// billing pages); lists that filter by calendar day get the days and the
// zone they are days in.

import type { Period } from "@/lib/activityReports";

type P = Pick<Period, "from" | "to" | "tz" | "startMs" | "endMs">;

function href(path: string, params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

const days = (p: P) => ({ from: p.from, to: p.to, tz: p.tz });
const instants = (p: P) => ({ from: p.startMs, to: p.endMs });

export const overviewLinks = {
  users: () => "/admin/users",
  newUsers: (p: P) => href("/admin/users", days(p)),
  activeUsers: (p: P) => href("/admin/analytics", { from: p.from, to: p.to }),
  liveMeetings: () => href("/admin/events", { state: "live" }),
  subscriptionsByPlan: (planId: string) => href("/admin/subscriptions", { view: "all", plan: planId }),
  subscriptionsByStatus: (status: string) => href("/admin/subscriptions", { view: "all", status }),
  renewalsDue: (days: number) => href("/admin/subscriptions", { view: "upcoming", days }),
  endedSubscriptions: (days: number) => href("/admin/subscriptions", { view: "ended", days }),
  revenue: (p: P) => href("/admin/billing/revenue", instants(p)),
  payments: (p: P) => href("/admin/billing/payments", instants(p)),
  failedPayments: (p: P) => href("/admin/billing/payments", { status: "failed", ...instants(p) }),
  refunds: (p: P) => href("/admin/billing/payments", { status: "refunds", ...instants(p) }),
  storage: () => "/admin/content/storage",
  storageByType: (type: string) => href("/admin/content", { type, state: "all" }),
  health: () => "/admin/ops",
  // The alerts page opens on the active ones.
  incidents: () => href("/admin/ops/incidents", { status: "open" }),
  alerts: () => "/admin/ops/alerts",
  jobs: () => "/admin/ops/jobs",
  failedJobs: () => "/admin/ops/jobs#failed-runs",
  job: (name: string) => href("/admin/ops/jobs", { job: name }),
  errors: (p: P) => href("/admin/logs", { severity: "error", from: p.from, to: p.to }),
  feature: (p: P, type: string) => href("/admin/logs", { type, from: p.from, to: p.to }),
};
