// /api/admin/content/files/[id] — content:read
//
// GET  one file's metadata: owner, related meeting or group, size, type,
//      status, visibility, checksum, moderation state and history, open
//      report cases, view/download counters for recordings. Never its
//      contents (./open), so this needs no support session.

import { NextResponse } from "next/server";
import { can, requireAdmin } from "@/lib/admin/context";
import { fail } from "@/lib/admin/http";
import { loadRows, ownerInfo } from "@/lib/content/admin";
import { getFile, trashWindowDays } from "@/lib/content/files";
import { listCases } from "@/lib/content/reports";
import { recordingAnalytics } from "@/lib/analytics";
import { activeSupportSession } from "@/lib/admin/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "content:read");
  if (!g.ok) return g.response;
  const rec = await getFile(params.id);
  if (!rec) return fail("not_found", "No such file in the index.", 404);
  const [row] = await loadRows([rec]);
  let owner = null;
  try {
    owner = rec.ownerId ? ((await ownerInfo([rec.ownerId])).get(rec.ownerId) ?? null) : null;
  } catch {
    owner = null;
  }
  const cases = (await listCases()).filter((c) => c.fileId === rec.id || (rec.eventSlug && c.eventSlug === rec.eventSlug));
  const stats = rec.type === "recording" && rec.storage === "r2" ? await recordingAnalytics.getStats(rec.key) : null;
  const support = await activeSupportSession(g.ctx.userId);
  const trashDays = await trashWindowDays();
  return NextResponse.json({
    file: row,
    owner,
    cases: cases.map((c) => ({ id: c.id, status: c.status, reportCount: c.reportCount, label: c.label, updatedAt: c.updatedAt })),
    stats,
    restoreUntil: rec.state === "trashed" ? (rec.stateAt ?? rec.updatedAt) + trashDays * 86_400_000 : null,
    // What opening the contents would need, so the page can say so before asking.
    access: {
      private: row.effectiveVisibility === "private",
      canSupport: can(g.ctx, "users:support_access"),
      supportOpenOnOwner: !!support && !!rec.ownerId && support.userId === rec.ownerId,
      viewable: rec.storage === "r2" || rec.type === "transcript",
    },
  });
}
