// /api/admin/offers/[id] (plans:write) — PATCH any field; DELETE removes it
// (payments it discounted keep its id on their record).

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { cleanOffer, strip } from "@/lib/billing/adminInput";
import { deleteOffer, getOffer, saveOffer } from "@/lib/billing/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "plans:write");
  if (!g.ok) return g.response;
  const existing = await getOffer(params.id);
  if (!existing) return fail("not_found", "That offer was not found.", 404);
  const body = await readJson(req);
  if (!body) return fail("bad_request", "Send the change as JSON.");
  const next = cleanOffer(body, existing, g.ctx.email);
  if (typeof next === "string") return fail("bad_offer", next);
  const change = diff(strip(existing) as Record<string, unknown>, strip(next) as Record<string, unknown>);
  if (!Object.keys(change.after).length) return NextResponse.json({ ok: true, offer: existing, unchanged: true });
  await saveOffer(next);
  await recordAdminAction(actorOf(g.ctx), req, { action: "offer.update", targetType: "offer", targetId: next.id, targetLabel: next.name, before: change.before, after: change.after });
  return NextResponse.json({ ok: true, offer: next });
}

export async function DELETE(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "plans:write");
  if (!g.ok) return g.response;
  const existing = await getOffer(params.id);
  if (!existing) return fail("not_found", "That offer was not found.", 404);
  await deleteOffer(existing.id);
  await recordAdminAction(actorOf(g.ctx), req, { action: "offer.delete", targetType: "offer", targetId: existing.id, targetLabel: existing.name, before: strip(existing) });
  return NextResponse.json({ ok: true });
}
