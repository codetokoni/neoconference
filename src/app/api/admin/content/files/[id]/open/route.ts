// /api/admin/content/files/[id]/open — view or download a file's contents.
//
// POST  content:read. Shared and public files: a 5-minute download link
//       (or a transcript's text). A PRIVATE file also needs
//       users:support_access (a fresh code) AND an open support session on
//       the file's owner (phase 2: Users > the account > Support session).
//       Every open is audited — who, which file, under which session; the
//       contents never go in the audit trail.

import { NextResponse } from "next/server";
import { actorOf, refuse, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { activeSupportSession } from "@/lib/admin/users";
import { loadRows } from "@/lib/content/admin";
import { getFile } from "@/lib/content/files";
import { signGetUrl } from "@/lib/r2";
import { transcribeStore } from "@/lib/transcribeStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const base = await requireAdmin(req, "content:read");
  if (!base.ok) return base.response;
  const rec = await getFile(params.id);
  if (!rec) return fail("not_found", "No such file in the index.", 404);
  const [row] = await loadRows([rec]);
  const label = rec.name || rec.key;

  let ctx = base.ctx;
  let sessionId: string | undefined;
  if (row.effectiveVisibility === "private") {
    const g = await requireAdmin(req, ["content:read", "users:support_access"]);
    if (!g.ok) {
      const body = (await g.response.clone().json().catch(() => ({}))) as { error?: string };
      if (body.error === "forbidden") {
        await recordAdminAction(actorOf(base.ctx), req, {
          action: "content.file.open",
          targetType: "file",
          targetId: rec.id,
          targetLabel: label,
          outcome: "denied",
          note: "Private file; the role has no support access.",
        });
        return refuse("forbidden", {
          permission: "users:support_access",
          message: "This file is private. Opening it needs the support-access permission and an open support session on its owner's account.",
        });
      }
      return g.response;
    }
    ctx = g.ctx;
    const session = await activeSupportSession(ctx.userId);
    if (!rec.ownerId || !session || session.userId !== rec.ownerId) {
      await recordAdminAction(actorOf(ctx), req, {
        action: "content.file.open",
        targetType: "file",
        targetId: rec.id,
        targetLabel: label,
        outcome: "denied",
        note: rec.ownerId ? "Private file; no open support session on its owner." : "Private file with no owner.",
      });
      return fail(
        "support_session_required",
        rec.ownerId
          ? "This file is private. Open a support session on its owner's account first (Users → the account → Support session), then open it from here."
          : "This file is private and has no owner, so no support session can cover it. Re-link it to its owner first.",
        403,
        { ownerId: rec.ownerId },
      );
    }
    sessionId = session.id;
  }

  let out: Record<string, unknown>;
  if (rec.storage === "r2") {
    out = { kind: "url", url: await signGetUrl(rec.key, 300), expiresIn: 300 };
  } else if (rec.type === "transcript" && rec.recordingKey) {
    const job = await transcribeStore.getByRecordingKey(rec.recordingKey);
    if (!job?.text) return fail("no_contents", "This transcript has no text (yet).", 404);
    out = { kind: "text", text: job.text, summary: job.summary ?? null };
  } else {
    return fail("not_viewable", "This kind of file can't be opened from here; it is kept with what it belongs to (the room's roster page).", 400);
  }
  await recordAdminAction(actorOf(ctx), req, {
    action: "content.file.open",
    targetType: "file",
    targetId: rec.id,
    targetLabel: label,
    after: { visibility: row.effectiveVisibility, ownerId: rec.ownerId, ...(sessionId ? { supportSession: sessionId } : {}) },
  });
  return NextResponse.json({ ok: true, ...out });
}
