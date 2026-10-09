// /api/admin/content/trash
//
// GET   content:read  the recordings and uploaded files in the trash (phase
//       11's recoverable deletion, src/lib/dataGov/trash.ts) — deleted by
//       their owners or moved there by an administrator — with when each
//       restore window closes (the "trash" retention setting).
// POST  content:moderate  { id, reason? } restore one: the file goes back to
//       where it was, and the index puts it back in the state it had.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { getFileByKey, listContentTrash, putFile, trashWindowDays } from "@/lib/content/files";
import { auditView, restoreRefusal, restoredRecord } from "@/lib/content/actions";
import { getTrashItem, restoreFromTrash } from "@/lib/dataGov/trash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "content:read");
  if (!g.ok) return g.response;
  const items = await listContentTrash();
  return NextResponse.json({
    days: await trashWindowDays(),
    items: items.map(({ item, record, restoreUntil, expired }) => ({
      trashId: item.id,
      kind: item.kind,
      label: item.label,
      key: item.ref,
      ownerId: item.ownerId,
      deletedAt: item.deletedAt,
      deletedBy: item.deletedBy,
      byOwner: !!item.ownerId && item.deletedBy === item.ownerId,
      size: record?.size ?? item.r2[0]?.size ?? null,
      fileId: record?.id ?? null,
      reason: record?.trashId === item.id ? (record.stateReason ?? null) : null,
      restoreUntil,
      expired,
    })),
    bytes: items.reduce((s, x) => s + (x.record?.size ?? 0), 0),
  });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "content:moderate");
  if (!g.ok) return g.response;
  const body = await readJson<{ id?: unknown; reason?: unknown }>(req);
  const id = str(body?.id, 80);
  const item = id ? await getTrashItem(id) : null;
  if (!item || (item.kind !== "recording" && item.kind !== "upload")) return fail("not_found", "No such file in the trash.", 404);
  const r = await restoreFromTrash(item.id, g.ctx.userId);
  if (!r.ok) return restoreRefusal(r.error, r.detail);
  const reason = str(body?.reason, 300) || "Restored from the trash";
  const rec = await getFileByKey("r2", item.ref);
  const next = rec ? restoredRecord(rec, g.ctx, reason) : null;
  if (next) await putFile(next);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "content.trash.restore",
    targetType: "file",
    targetId: rec?.id ?? item.ref,
    targetLabel: item.label,
    before: rec ? auditView(rec) : { trashed: true, trashId: item.id },
    after: next ? auditView(next) : { restored: true },
    note: reason,
  });
  return NextResponse.json({ ok: true, file: next, restored: r.objects });
}
