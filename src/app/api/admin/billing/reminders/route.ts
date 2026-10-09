// /api/admin/billing/reminders
//
// GET   rules, the send log, and what the next run would send (billing:read)
// PUT   { failed, abandoned, renewal } rules (billing:settings, fresh code)
// POST  run now, as the daily cron does (billing:settings, fresh code).
//       Each reminder still goes out once at most (src/lib/finance/reminders.ts).

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { fail, readJson } from "@/lib/admin/http";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { isMailConfigured } from "@/lib/mail";
import { cleanRules, getReminderRules, readReminderLog, runReminders, saveReminderRules } from "@/lib/finance/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "billing:read");
  if (!g.ok) return g.response;
  const preview = await runReminders(Date.now(), { dryRun: true });
  return NextResponse.json({
    ok: true,
    rules: await getReminderRules(),
    log: await readReminderLog(100),
    preview,
    mailConfigured: isMailConfigured(),
  });
}

export async function PUT(req: Request) {
  const g = await requireAdmin(req, "billing:settings");
  if (!g.ok) return g.response;
  const rules = cleanRules(await readJson(req));
  if (typeof rules === "string") return fail("invalid_rules", rules);
  const before = await getReminderRules();
  const strip = (r: typeof rules) => ({ failed: r.failed, abandoned: r.abandoned, renewal: r.renewal });
  const changes = diff(strip(before), strip(rules));
  await saveReminderRules({ ...rules, updatedAt: Date.now(), updatedBy: g.ctx.email });
  if (Object.keys(changes.after).length) {
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "billing.reminders.update",
      targetType: "billing_settings",
      targetId: "reminders",
      targetLabel: "Billing reminder rules",
      before: changes.before,
      after: changes.after,
    });
  }
  return NextResponse.json({ ok: true, rules: await getReminderRules() });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "billing:settings");
  if (!g.ok) return g.response;
  const result = await runReminders(Date.now(), { by: g.ctx.email });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "billing.reminders.run",
    targetType: "billing_settings",
    targetId: "reminders",
    targetLabel: "Billing reminders",
    after: { sent: result.sent, failed: result.failed, alreadySent: result.alreadySent, skipped: result.skipped ?? null },
  });
  return NextResponse.json({ ok: true, result });
}
