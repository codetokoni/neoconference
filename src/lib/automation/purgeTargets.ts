// src/lib/automation/purgeTargets.ts
//
// Data with a retention rule that an automation rule may purge. Data
// governance owns the retention periods and the purge functions and
// registers each here; an automation rule with action { kind: "purge",
// target: <id> } then runs it on a schedule (locked, previewed, audited,
// and always behind a fresh authenticator code).
//
// plan() lists what is past retention now (oldest first, at most `limit`),
// each with a stable key; purge() deletes one. Both must be safe to repeat.

import type { Performed, Target } from "@/lib/automation/actions";

export interface PurgeTarget {
  id: string;
  label: string;
  plan(now: number, limit: number): Promise<Target[]>;
  purge(t: Target, actor: string): Promise<Performed>;
}

export const PURGE_TARGETS: PurgeTarget[] = [];
