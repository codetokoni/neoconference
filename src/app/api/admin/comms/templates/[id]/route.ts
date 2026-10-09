// /api/admin/comms/templates/[id] — one email template (notifications:send).
//
// GET   the definition (variables with sample values), the default, the
//       version in use and the version history
// PUT   { subject, html, text, short?, note? } save a new version. Audited
//       with the text before and after.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { checkParts, cleanParts, getTemplate, saveTemplate, templateHistory } from "@/lib/comms/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const t = await getTemplate(params.id);
  if (!t) return fail("not_found", "That template was not found.", 404);
  return NextResponse.json(
    { def: t.def, current: t.current, active: t.active, history: await templateHistory(t.def.id) },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PUT(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const t = await getTemplate(params.id);
  if (!t) return fail("not_found", "That template was not found.", 404);
  const body = await readJson(req);
  if (!body) return fail("invalid_body", "Send the template as JSON.");
  const parts = cleanParts(body, t.def);
  const problems = checkParts(t.def, parts);
  if (problems.length) return fail("invalid_template", problems[0], 400, { problems });
  const same =
    parts.subject === t.active.subject && parts.html === t.active.html && parts.text === t.active.text && (parts.short ?? "") === (t.active.short ?? "");
  if (same) return NextResponse.json({ ok: true, unchanged: true, active: t.active });
  const { before, after } = await saveTemplate(t.def.id, parts, actorOf(g.ctx), str(body.note, 200) || undefined);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "template.update",
    targetType: "template",
    targetId: t.def.id,
    targetLabel: t.def.name,
    before,
    after: { subject: after.subject, html: after.html, text: after.text, ...(after.short !== undefined ? { short: after.short } : {}), version: after.version },
    ...(after.note ? { note: after.note } : {}),
  });
  return NextResponse.json({ ok: true, active: after });
}
