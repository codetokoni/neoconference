// src/lib/automation/purgeTargets.ts
//
// Data with a retention period that an automation rule may purge, one per
// data-governance purge (src/lib/dataGov/purge.ts). Data governance owns the
// periods (daysFor) and what each purge finds and removes; a rule only
// decides when. So a scheduled purge does exactly what Admin → Data → Purge
// does by hand:
//
//   plan   def.find(daysFor(id), now) — nothing when def.unavailable() says why
//   purge  def.remove(on exactly the planned records) inside the job runner
//          as "data-purge", the lock the manual purges take, so the two never
//          overlap; then a "data.purge" audit entry with counts only.
//
// Completing account deletions is not a target: it stays manual.

import type { BatchResult, Target } from "@/lib/automation/actions";
import { recordAdminAction } from "@/lib/admin/audit";
import { daysFor, PURGES, type PurgeDef, type PurgeRecord } from "@/lib/dataGov/purge";
import { runJob } from "@/lib/ops/jobs";

export const PURGE_JOB = "data-purge";

export interface PurgeTarget {
  id: string;
  label: string;
  plan(now: number): Promise<{ targets: Target[]; note?: string }>;
  purge(targets: Target[], actor: string, now: number): Promise<BatchResult>;
}

function labelOf(r: PurgeRecord): string {
  const v = r.view ?? {};
  if (typeof v.number === "number") return `Ticket #${v.number}`;
  const name = v.label ?? v.list ?? v.key ?? v.name ?? v.title;
  return typeof name === "string" && name ? name : r.id;
}

function detailOf(r: PurgeRecord): string | undefined {
  const parts: string[] = [];
  if (r.entries != null) parts.push(`${r.entries} entr${r.entries === 1 ? "y" : "ies"}`);
  if (r.bytes) parts.push(`${(r.bytes / 1e6).toFixed(1)} MB`);
  return parts.join(", ") || undefined;
}

function adapter(def: PurgeDef): PurgeTarget {
  return {
    id: def.id,
    label: def.label,
    async plan(now) {
      const days = await daysFor(def.id);
      const why = def.unavailable(days);
      if (why) return { targets: [], note: why };
      const records = await def.find(days, now);
      return {
        targets: records.map((r) => ({
          key: `purge:${def.id}:${r.id}:${r.fingerprint ?? ""}`,
          label: labelOf(r),
          detail: detailOf(r),
          data: { record: r },
        })),
        note: days == null ? undefined : `Retention period: ${days} day${days === 1 ? "" : "s"}`,
      };
    },
    async purge(targets, actor, now) {
      const days = await daysFor(def.id);
      const why = def.unavailable(days);
      if (why) throw new Error(why);
      const records = targets.map((t) => (t.data as { record: PurgeRecord }).record);
      let out = { removed: 0, bytes: 0 };
      const r = await runJob(
        PURGE_JOB,
        async () => {
          out = await def.remove(records, days, now);
          return { ok: true, summary: `${def.id}: ${out.removed} removed` };
        },
        { trigger: "automation", actor },
      );
      if (r.status === "locked") throw new Error("A purge is already running (Admin → Data, or another rule). Nothing was removed.");
      if (r.run.outcome === "failed") throw new Error(r.run.error || "purge failed");
      await recordAdminAction({ userId: actor, email: "automation" }, null, {
        action: "data.purge",
        targetType: "retention",
        targetId: def.id,
        targetLabel: def.label,
        after: { records: records.length, removed: out.removed, bytes: out.bytes, periodDays: days },
      });
      return { done: out.removed, already: Math.max(0, records.length - out.removed), skipped: 0, failed: 0, errors: [], summary: `${out.removed} removed, ${(out.bytes / 1e6).toFixed(1)} MB` };
    },
  };
}

export const PURGE_TARGETS: PurgeTarget[] = PURGES.map(adapter);
