// /api/admin/ops/alerts — alert history and rules (ops:read).
//   ?status=active|open|acknowledged|resolved

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { ALERT_KINDS, listAlerts, listRules, type AlertStatus } from "@/lib/ops/alerts";
import { PROBES } from "@/lib/ops/probes";
import { JOBS } from "@/lib/ops/jobRegistry";
import { opsRecipients } from "@/lib/ops/notify";
import { isMailConfigured } from "@/lib/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "ops:read");
  if (!g.ok) return g.response;
  const s = new URL(req.url).searchParams.get("status");
  const status = (["active", "open", "acknowledged", "resolved"].includes(s ?? "") ? s : undefined) as AlertStatus | "active" | undefined;
  const [alerts, rules, recipients] = await Promise.all([listAlerts({ status, limit: 200 }), listRules(), opsRecipients()]);
  return NextResponse.json({
    ok: true,
    alerts,
    rules,
    kinds: ALERT_KINDS,
    targets: { services: PROBES.map((p) => ({ id: p.id, label: p.label })), jobs: JOBS.map((j) => ({ id: j.name, label: j.label })) },
    recipients: recipients.map((r) => ({ email: r.email, owner: r.owner })),
    emailConfigured: isMailConfigured(),
  });
}
