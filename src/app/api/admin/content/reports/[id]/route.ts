// /api/admin/content/reports/[id]
//
// GET   content:read  one case: the reports, history and notes.
// POST  content:moderate  { action, note?, message? }
//   note              add a note to the case
//   hide | unhide     unpublish the reported replay or recording / put it back
//   trash | restore   recoverable deletion of the reported file (a fresh code)
//   warn              tell the owner, in the app, with your message — never who reported
//   escalate          record that the owner's account was suspended (phase 2's
//                     Suspend action does the suspending; this also needs users:suspend)
//   dismiss | reopen  close without action / open again
// Every action is in the case history and the audit trail.

import { NextResponse } from "next/server";
import { actorOf, can, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { loadTargetUser } from "@/lib/admin/users";
import { caseView, getCase, newId, saveCase, withEvent, type ReportCase } from "@/lib/content/reports";
import { getFile, getHiddenEvent, setHiddenEvent } from "@/lib/content/files";
import { changeFileState } from "@/lib/content/actions";
import { addNotification } from "@/lib/notificationStore";
import type { AdminPermission } from "@/lib/admin/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

const ACTIONS = ["note", "hide", "unhide", "trash", "restore", "warn", "escalate", "dismiss", "reopen"] as const;
type Action = (typeof ACTIONS)[number];

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "content:read");
  if (!g.ok) return g.response;
  const c = await getCase(params.id);
  if (!c) return fail("not_found", "No such case.", 404);
  const file = c.fileId ? await getFile(c.fileId) : null;
  const hidden = c.eventSlug ? await getHiddenEvent(c.eventSlug) : null;
  return NextResponse.json({
    case: caseView(c, { showReporters: can(g.ctx, "content:moderate") }),
    target: { file, eventHidden: !!hidden, hiddenAt: hidden?.at ?? null },
  });
}

export async function POST(req: Request, { params }: Params) {
  const body = await readJson<{ action?: unknown; note?: unknown; message?: unknown }>(req);
  const action = ACTIONS.find((a) => a === body?.action) as Action | undefined;
  const perms: AdminPermission[] = action === "escalate" ? ["content:moderate", "users:suspend"] : ["content:moderate"];
  const g = await requireAdmin(req, perms, { stepUp: action === "trash" });
  if (!g.ok) return g.response;
  if (!action) return fail("bad_action", "Unknown action.");
  let c = await getCase(params.id);
  if (!c) return fail("not_found", "No such case.", 404);
  const actor = { byId: g.ctx.userId, byEmail: g.ctx.email };
  const note = str(body?.note, 1000);

  const finish = async (next: ReportCase, after: unknown, before?: unknown) => {
    await saveCase(next);
    await recordAdminAction(actorOf(g.ctx), req, {
      action: `content.report.${action}`,
      targetType: "report",
      targetId: next.id,
      targetLabel: next.label,
      before,
      after,
      note: note || undefined,
    });
    return NextResponse.json({ ok: true, case: caseView(next, { showReporters: true }) });
  };
  const unchanged = () => NextResponse.json({ ok: true, unchanged: true, case: caseView(c!, { showReporters: true }) });
  const actioned = (x: ReportCase): ReportCase => (x.status === "actioned" ? x : { ...x, status: "actioned", newSinceClosed: 0 });

  if (action === "note") {
    if (!note) return fail("note_required", "Write the note.");
    const now = Date.now();
    const next = { ...c, updatedAt: now, notes: [{ id: newId("note").toLowerCase(), at: now, ...actor, text: note }, ...c.notes].slice(0, 200) };
    return finish(next, { note: true });
  }

  if (action === "dismiss" || action === "reopen") {
    const status = action === "dismiss" ? "dismissed" : "open";
    if (c.status === status) return unchanged();
    const next = withEvent({ ...c, status, newSinceClosed: 0 }, { ...actor, action, note, before: { status: c.status }, after: { status } });
    return finish(next, { status }, { status: c.status });
  }

  if (action === "warn") {
    const message = str(body?.message, 500);
    if (!message) return fail("message_required", "Write what the owner should be told.");
    if (!c.ownerId) return fail("no_owner", "This content has no owner to warn.", 409);
    // Built from the administrator's words and the target only: nothing about who reported it.
    await addNotification(c.ownerId, {
      type: "updated",
      title: "A message from NeoConference about your content",
      body: `${c.label ? `About "${c.label}": ` : ""}${message}`,
      url: c.eventSlug ? `/e/${encodeURIComponent(c.eventSlug)}/replay` : "/dashboard/recordings",
    });
    const next = actioned(withEvent(c, { ...actor, action, note: message }));
    return finish(next, { warned: c.ownerId });
  }

  if (action === "escalate") {
    if (!c.ownerId) return fail("no_owner", "This content has no owner to suspend.", 409);
    const t = await loadTargetUser(c.ownerId);
    if ("response" in t) return t.response;
    if (!t.user.banned) {
      return fail("suspend_first", "The owner's account is not suspended. Suspend it first (the Suspend button here, or Users → the account), then record it on the case.", 409);
    }
    const next = actioned(withEvent(c, { ...actor, action, note, after: { suspended: true, userId: c.ownerId } }));
    return finish(next, { ownerSuspended: true, userId: c.ownerId });
  }

  // hide / unhide / trash / restore
  if ((action === "hide" || action === "trash") && !note) return fail("reason_required", "Say why (it goes in the case and the audit log).");
  if (c.fileId) {
    const rec = await getFile(c.fileId);
    if (!rec) return fail("file_gone", "The reported file is no longer in the index.", 404);
    const r = await changeFileState(g.ctx, req, rec, action, note, c.id);
    if ("response" in r) return r.response;
    if (r.unchanged) return unchanged();
    c = withEvent(c, { ...actor, action, note, before: { state: rec.state }, after: { state: r.record.state } });
    return finish(action === "hide" || action === "trash" ? actioned(c) : c, { state: r.record.state }, { state: rec.state });
  }
  if (c.eventSlug) {
    if (action === "trash" || action === "restore") {
      return fail("event_not_trashable", "A meeting can be hidden here, not trashed. Deleting a meeting is under Meetings.", 400);
    }
    const was = await getHiddenEvent(c.eventSlug);
    if (action === "hide" ? was : !was) return unchanged();
    await setHiddenEvent(c.eventSlug, action === "hide" ? { at: Date.now(), byId: g.ctx.userId, byEmail: g.ctx.email, reason: note, caseId: c.id } : null);
    c = withEvent(c, { ...actor, action, note, before: { hidden: !!was }, after: { hidden: action === "hide" } });
    return finish(action === "hide" ? actioned(c) : c, { eventHidden: action === "hide", slug: c.eventSlug }, { eventHidden: !!was });
  }
  return fail("no_target", "This case has nothing to act on.", 400);
}
