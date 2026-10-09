// /api/admin/content/limits
//
// GET  content:read  the size and type limits in force at each upload point,
//      the defaults, and the file types that can be allowed.
// PUT  content:moderate + a fresh code  { rules: { [kind]: { maxBytes, mimes } } }
//      Takes effect on the next upload, server-side, at every upload route.
//      Retention of files is a data-governance setting, not this one.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { DEFAULT_UPLOAD_RULES, KNOWN_FILE_TYPES, MAX_UPLOAD_CEILING, UPLOAD_KINDS, cleanRule, isUploadKind, type UploadKind, type UploadRule } from "@/lib/content/model";
import { saveUploadRules, savedLimits, uploadRules } from "@/lib/content/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "content:read");
  if (!g.ok) return g.response;
  const saved = await savedLimits();
  return NextResponse.json({
    rules: await uploadRules(),
    defaults: DEFAULT_UPLOAD_RULES,
    kinds: UPLOAD_KINDS,
    fileTypes: KNOWN_FILE_TYPES,
    ceiling: MAX_UPLOAD_CEILING,
    updatedAt: saved.updatedAt ?? null,
    updatedByEmail: saved.updatedByEmail ?? null,
    quotas: { enforced: false },
  });
}

export async function PUT(req: Request) {
  const g = await requireAdmin(req, "content:moderate", { stepUp: true });
  if (!g.ok) return g.response;
  const body = await readJson<{ rules?: Record<string, unknown> }>(req);
  if (!body?.rules || typeof body.rules !== "object") return fail("bad_rules", "Send the rules to save.");
  const before = await uploadRules();
  const next: Partial<Record<UploadKind, UploadRule>> = { ...(await savedLimits()).rules };
  for (const [k, v] of Object.entries(body.rules)) {
    if (!isUploadKind(k)) return fail("bad_kind", `Not an upload point: ${k}.`);
    const clean = cleanRule(v);
    if ("error" in clean) return fail("bad_rule", `${UPLOAD_KINDS.find((x) => x.id === k)?.label}: ${clean.error}`);
    next[k] = clean;
  }
  await saveUploadRules(next, actorOf(g.ctx));
  const after = await uploadRules();
  const d = diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "content.limits.update",
    targetType: "settings",
    targetId: "upload-limits",
    targetLabel: "Upload limits",
    before: d.before,
    after: d.after,
  });
  return NextResponse.json({ ok: true, rules: after });
}
