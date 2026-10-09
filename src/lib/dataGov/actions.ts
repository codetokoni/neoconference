// src/lib/dataGov/actions.ts
//
// The data-governance bulk actions, each a previewed, token-checked action
// (src/lib/admin/bulk.ts):
//
//   complete-deletions  complete due deletion requests (erase.ts)      destructive
//   restore             restore items from the trash                    —
//   purge               remove what a retention period has passed       destructive
//   retention           change a retention period                       —
//
// Each writes its own audit entries: counts and ids, never names or emails
// of the people whose data was removed.

import { clerkClient } from "@clerk/nextjs/server";
import { recordAdminAction } from "@/lib/admin/audit";
import { defineBulkAction, type BulkActor, type BulkRecord } from "@/lib/admin/bulk";
import type { ClerkUserish } from "@/lib/admin/users";
import { eraseAccount, erasureBlockers, planErasure, type Blocker, type DeletionCertificate } from "@/lib/dataGov/erase";
import { closeRequest, openRequests, rescheduleOpen, openStatus, requestId, type DeletionRequest } from "@/lib/dataGov/requests";
import { getTrashItem, listTrash, restoreCheck, restoreFromTrash, trashWindowMs, expiresAt } from "@/lib/dataGov/trash";
import { checkValue, cutoffFor, DAY_MS, getRetention, retentionDef, saveRetentionValue, type RetentionCategory } from "@/lib/dataGov/settings";
import { daysFor, purgeDef, type PurgeCategory, type PurgeRecord } from "@/lib/dataGov/purge";
import { jobLockHolder, runJob } from "@/lib/ops/jobs";

const actorAudit = (a: BulkActor) => ({ userId: a.userId, email: a.email });

/** Job names in the operations job runner (src/lib/ops/jobs.ts): one lock each, runs listed on the Jobs page. */
export const DATA_JOBS = { deletions: "data-deletions", restore: "data-restore", purge: "data-purge" } as const;
const JOB_LOCK_MS = 5 * 60 * 1000;

const busyIf = (job: string) => async () => ((await jobLockHolder(job)) ? "The same data job is running right now. Try again when it has finished." : null);

/**
 * Run a data job through the job runner: locked (one at a time), timed and
 * recorded with its outcome. A throw is recorded as a failure and rethrown.
 */
export async function asJob<T>(job: string, actor: BulkActor, fn: () => Promise<T>, summary: (out: T) => string): Promise<T> {
  let out: T | undefined;
  const r = await runJob(
    job,
    async () => {
      out = await fn();
      return { ok: true, summary: summary(out) };
    },
    { trigger: "manual", actor: actor.email, lockMs: JOB_LOCK_MS },
  );
  if (r.status === "locked") throw new Error("The same data job is running right now.");
  if (r.error) throw r.error;
  return out as T;
}
const idList = (input: unknown, max = 500): string[] | null => {
  if (!Array.isArray(input)) return null;
  const ids = [...new Set(input.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_:.-]{1,128}$/.test(x)))];
  return ids.length && ids.length <= max ? ids.sort() : null;
};

/* ---------------------------- complete deletions --------------------------- */

type DeletionSelection = { userIds: string[] } | { due: true };

interface DeletionRecord extends BulkRecord {
  request: DeletionRequest;
}

/** Due requests in the selection, split into those that can complete and those blocked. */
async function dueRequests(sel: DeletionSelection, now = Date.now()) {
  const open = await openRequests();
  const wanted = "due" in sel ? [...open.keys()] : sel.userIds;
  const ready: DeletionRecord[] = [];
  const skipped: { userId: string; reason: string; blockers?: Blocker[] }[] = [];
  const client = await clerkClient();
  for (const uid of wanted.sort()) {
    const d = open.get(uid);
    if (!d) {
      if (!("due" in sel)) skipped.push({ userId: uid, reason: "no open request" });
      continue;
    }
    if (openStatus(d, now) !== "scheduled") {
      if (!("due" in sel)) skipped.push({ userId: uid, reason: `grace period runs until ${new Date(d.deleteAfter).toISOString()}` });
      continue;
    }
    let user: ClerkUserish;
    try {
      user = (await client.users.getUser(uid)) as unknown as ClerkUserish;
    } catch {
      skipped.push({ userId: uid, reason: "account not found" });
      continue;
    }
    const blockers = await erasureBlockers(uid, user);
    if (blockers.length) {
      skipped.push({ userId: uid, reason: blockers.map((b) => b.code).join(", "), blockers });
      continue;
    }
    const email = (user.emailAddresses ?? [])[0]?.emailAddress ?? "";
    ready.push({
      id: uid,
      fingerprint: `${d.requestedAt}:${d.deleteAfter}`,
      request: d,
      view: { email, requestedAt: d.requestedAt, deleteAfter: d.deleteAfter, source: d.source ?? "admin" },
    });
  }
  return { ready, skipped };
}

export const completeDeletionsAction = defineBulkAction<DeletionSelection, DeletionRecord, { completed: string[]; failed: { userId: string; error: string }[] }>({
  name: "deletions.complete",
  destructive: true,
  parse: (input) => {
    const o = (input ?? {}) as { userIds?: unknown; due?: unknown };
    if (o.due === true) return { due: true };
    const ids = idList(o.userIds, 100);
    return ids ? { userIds: ids } : null;
  },
  resolve: async (sel) => (await dueRequests(sel)).ready,
  extra: async (sel, records) => {
    const { skipped } = await dueRequests(sel);
    // What completing would remove, per data-map step, for the first few (each is a full scan).
    const plans: Record<string, Record<string, number>> = {};
    for (const r of records.slice(0, 5)) plans[r.id] = await planErasure(r.id);
    return { skipped, plans };
  },
  busy: busyIf(DATA_JOBS.deletions),
  run: (records, _sel, actor) =>
    asJob(
      DATA_JOBS.deletions,
      actor,
      async () => {
        const completed: string[] = [];
        const failed: { userId: string; error: string }[] = [];
        for (const r of records) {
          const res = await completeDeletion(r.id, r.request, actor);
          if (res.ok) completed.push(r.id);
          else failed.push({ userId: r.id, error: "blockers" in res ? res.blockers.map((b) => b.code).join(", ") : res.error });
        }
        return { completed, failed };
      },
      (o) => `${o.completed.length} account(s) deleted, ${o.failed.length} not`,
    ),
});

/**
 * Complete one due request: erase, close the request, write the certificate
 * to the audit trail. Shared by the bulk action and phase 2's "Delete now".
 */
export async function completeDeletion(
  uid: string,
  d: DeletionRequest,
  actor: BulkActor,
): Promise<{ ok: true; certificate: DeletionCertificate } | { ok: false; blockers: Blocker[] } | { ok: false; error: string }> {
  const rid = d.id ?? requestId(uid, d.requestedAt);
  try {
    const res = await eraseAccount(uid, actorAudit(actor), { id: rid, requestedAt: d.requestedAt, source: d.source ?? "admin" });
    if (!res.ok) return res;
    await closeRequest(uid, d, "completed", actor.userId, { certificateId: res.certificate.certificateId });
    await recordAdminAction(actorAudit(actor), actor.req, {
      action: "data.deletion.certificate",
      targetType: "user",
      targetId: uid,
      targetLabel: "deleted account",
      after: res.certificate,
      note: `Deletion request ${rid} completed.`,
    });
    return res;
  } catch (err) {
    console.error("[data] erase failed", uid, err);
    await recordAdminAction(actorAudit(actor), actor.req, {
      action: "data.deletion.complete",
      targetType: "user",
      targetId: uid,
      targetLabel: "account",
      outcome: "failed",
      note: "Erase stopped part-way; the account is still there and can be completed again.",
    });
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "failed" };
  }
}

/* --------------------------------- restore -------------------------------- */

interface TrashRecord extends BulkRecord {
  trashId: string;
}

export const restoreAction = defineBulkAction<{ ids: string[] }, TrashRecord, { restored: string[]; failed: { id: string; error: string }[] }>({
  name: "trash.restore",
  destructive: false,
  parse: (input) => {
    const ids = idList((input as { ids?: unknown })?.ids, 200);
    return ids ? { ids } : null;
  },
  resolve: async (sel) => {
    const out: TrashRecord[] = [];
    const win = await trashWindowMs();
    for (const id of sel.ids) {
      const t = await getTrashItem(id);
      if (!t || t.restoredAt || expiresAt(t, win) <= Date.now()) continue;
      out.push({ id, trashId: id, fingerprint: String(t.deletedAt), view: { kind: t.kind, label: t.label, ownerId: t.ownerId, deletedAt: t.deletedAt, expiresAt: expiresAt(t, win) } });
    }
    return out;
  },
  extra: async (sel, records) => {
    const conflicts: { id: string; error: string; detail?: string }[] = [];
    for (const r of records) {
      const t = await getTrashItem(r.id);
      const c = t ? await restoreCheck(t) : null;
      if (c && !c.ok) conflicts.push({ id: r.id, error: c.error, detail: c.detail });
    }
    const missing = sel.ids.filter((id) => !records.some((r) => r.id === id));
    return { conflicts, notRestorable: missing };
  },
  busy: busyIf(DATA_JOBS.restore),
  run: (records, _sel, actor) => asJob(DATA_JOBS.restore, actor, () => restoreRecords(records, actor), (o) => `${o.restored.length} restored, ${o.failed.length} not`),
});

async function restoreRecords(records: TrashRecord[], actor: BulkActor) {
  const restored: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const r of records) {
    const res = await restoreFromTrash(r.id, actor.userId);
    if (!res.ok) {
      failed.push({ id: r.id, error: res.detail ? `${res.error}: ${res.detail}` : res.error });
      continue;
    }
    restored.push(r.id);
    await recordAdminAction(actorAudit(actor), actor.req, {
      action: "data.trash.restore",
      targetType: res.item.kind,
      targetId: res.item.ref,
      targetLabel: res.item.label,
      after: { trashId: r.id, keys: res.keys, objects: res.objects, ownerId: res.item.ownerId },
    });
  }
  return { restored, failed };
}

/* ---------------------------------- purge --------------------------------- */

export const purgeAction = defineBulkAction<{ category: PurgeCategory }, PurgeRecord, { removed: number; bytes: number }>({
  name: "data.purge",
  destructive: true,
  parse: (input) => {
    const c = (input as { category?: unknown })?.category;
    return typeof c === "string" && purgeDef(c) ? { category: c as PurgeCategory } : null;
  },
  resolve: async (sel) => {
    const def = purgeDef(sel.category)!;
    const days = await daysFor(sel.category);
    if (def.unavailable(days)) return [];
    return def.find(days, Date.now());
  },
  totals: (records) => ({
    bytes: records.reduce((a, r) => a + (r.bytes ?? 0), 0),
    entries: records.reduce((a, r) => a + (r.entries ?? 1), 0),
  }),
  extra: async (sel) => {
    const def = purgeDef(sel.category)!;
    const days = await daysFor(sel.category);
    return { label: def.label, days, unavailable: def.unavailable(days) };
  },
  busy: busyIf(DATA_JOBS.purge),
  run: async (records, sel, actor) => {
    const def = purgeDef(sel.category)!;
    const days = await daysFor(sel.category);
    const r = await asJob(DATA_JOBS.purge, actor, () => def.remove(records, days, Date.now()), (o) => `${sel.category}: ${o.removed} removed`);
    await recordAdminAction(actorAudit(actor), actor.req, {
      action: "data.purge",
      targetType: "retention",
      targetId: sel.category,
      targetLabel: def.label,
      after: { records: records.length, removed: r.removed, bytes: r.bytes, periodDays: days },
    });
    return r;
  },
});

/* -------------------------------- retention -------------------------------- */

interface RetentionSelection {
  category: RetentionCategory;
  days: number | null;
}

/**
 * What saving a new value would affect. Saving deletes nothing; this lists
 * what would then be eligible for a purge (or, for deleted accounts, the
 * open requests whose date moves).
 */
async function retentionEffect(sel: RetentionSelection): Promise<BulkRecord[]> {
  const now = Date.now();
  if (sel.category === "accounts") {
    const grace = (sel.days ?? 30) * DAY_MS;
    return [...(await openRequests()).entries()]
      .filter(([, d]) => d.requestedAt + grace !== d.deleteAfter)
      .map(([uid, d]) => ({
        id: uid,
        fingerprint: `${d.deleteAfter}`,
        view: { from: d.deleteAfter, to: d.requestedAt + grace, dueNow: d.requestedAt + grace <= now },
      }));
  }
  if (sel.category === "trash") {
    const win = (sel.days ?? 30) * DAY_MS;
    return (await listTrash({ includeRestored: true }))
      .filter((t) => t.deletedAt + win <= now)
      .map((t) => ({ id: t.id, fingerprint: String(t.deletedAt), view: { kind: t.kind, label: t.label, deletedAt: t.deletedAt } }));
  }
  const def = purgeDef(sel.category);
  if (!def || def.unavailable(sel.days)) return [];
  return def.find(sel.days, now);
}

export const retentionAction = defineBulkAction<RetentionSelection, BulkRecord, { saved: true; rescheduled: number }>({
  name: "retention.change",
  destructive: false,
  parse: (input) => {
    const o = (input ?? {}) as { category?: unknown; days?: unknown };
    const def = typeof o.category === "string" ? retentionDef(o.category) : undefined;
    if (!def) return null;
    const c = checkValue(def, o.days);
    return c.ok ? { category: def.id, days: c.days } : null;
  },
  resolve: retentionEffect,
  extra: async (sel) => {
    const cur = await getRetention();
    const def = retentionDef(sel.category)!;
    return {
      label: def.label,
      meaning: def.meaning,
      current: cur.values[sel.category],
      next: sel.days,
      cutoff: cutoffFor(sel.days),
      note:
        sel.category === "accounts"
          ? "Open deletion requests move to the new date. Nothing is deleted by saving."
          : "Nothing is deleted by saving. The records listed become eligible for a purge, which is previewed and applied separately.",
    };
  },
  run: async (_records, sel, actor) => {
    const before = (await getRetention()).values[sel.category];
    await saveRetentionValue(sel.category, sel.days, actor.email);
    const rescheduled = sel.category === "accounts" ? await rescheduleOpen((sel.days ?? 30) * DAY_MS) : 0;
    await recordAdminAction(actorAudit(actor), actor.req, {
      action: "data.retention.change",
      targetType: "retention",
      targetId: sel.category,
      targetLabel: retentionDef(sel.category)!.label,
      before: { days: before },
      after: { days: sel.days, rescheduledRequests: rescheduled },
    });
    return { saved: true, rescheduled };
  },
});

export const BULK_ACTIONS = {
  "complete-deletions": completeDeletionsAction,
  restore: restoreAction,
  purge: purgeAction,
  retention: retentionAction,
} as const;

export type BulkActionName = keyof typeof BULK_ACTIONS;
