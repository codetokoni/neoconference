// /api/admin/comms/templates/[id]/test — send it to yourself (notifications:send).
//
// POST { subject?, html?, text?, short? }   the unsaved edit, or nothing for
//      the version in use. Filled with the sample values and sent only to
//      the signed-in administrator's own address, subject marked [Test].

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { checkParts, cleanParts, getTemplate, renderParts } from "@/lib/comms/templates";
import { sampleVars } from "@/lib/comms/templateDefaults";
import { isMailConfigured, sendMail } from "@/lib/mail";
import { logEmail } from "@/lib/comms/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const t = await getTemplate(params.id);
  if (!t) return fail("not_found", "That template was not found.", 404);
  if (!isMailConfigured()) return fail("mail_not_configured", "Email is not set up (RESEND_API_KEY), so nothing can be sent.", 503);
  if (!g.ctx.email) return fail("no_email", "Your account has no email address to send the test to.", 400);
  const body = (await readJson(req)) ?? {};
  const hasEdit = ["subject", "html", "text", "short"].some((k) => typeof body[k] === "string");
  const parts = hasEdit ? cleanParts(body, t.def) : t.active;
  const problems = checkParts(t.def, parts);
  if (problems.length) return fail("invalid_template", problems[0], 400, { problems });
  const r = renderParts(parts, sampleVars(t.def));
  const subject = `[Test] ${r.subject}`;
  const sent = await sendMail({ to: g.ctx.email, subject, ...(r.html ? { html: r.html } : {}), ...(r.text ? { text: r.text } : {}) });
  await logEmail({
    source: "test",
    template: t.def.id,
    templateVersion: hasEdit ? -1 : t.active.version,
    to: g.ctx.email,
    recipients: 1,
    subject,
    status: sent.ok ? "sent" : "failed",
    ...(sent.ok ? { resendId: sent.id } : { error: sent.error }),
  });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "template.test",
    targetType: "template",
    targetId: t.def.id,
    targetLabel: t.def.name,
    after: { to: g.ctx.email, unsaved: hasEdit, ok: sent.ok },
    outcome: sent.ok ? "ok" : "failed",
  });
  if (!sent.ok) return fail("send_failed", `The test email was not sent: ${sent.error}`, 502);
  return NextResponse.json({ ok: true, to: g.ctx.email });
}
