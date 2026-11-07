// src/lib/ops/retentionSweep.ts
//
// One pass after the November 2026 retention changes. Keys written under the
// old, longer expiry would otherwise keep it: a partner session written on
// 1 November would stay until December 2027. This gives each one the
// expiry it would have had under the new period (same write time: the old
// remaining time less the difference), and removes it if that has already
// passed.
//
//   partner session detail (neo:pz:*, not the day totals)   400 → 90 days
//   raw activity log and each person's list (neo:act:log:*, neo:act:u:*)   90 → 30 days
//   job run records (neo:ops:job:run:*)                      60 → 14 days
//
// Only a key whose remaining time is longer than the new period is touched,
// so a key written since (already on the new period) is left alone; each
// key is checked and changed in one script, so a write in between cannot be
// overwritten. It runs a little at a time from the five-minute health job
// (src/app/api/cron/ops-health/route.ts), remembers where it got to, and
// does nothing once finished.
//
//   neo:ops:retention-sweep:2026-11   JSON SweepState

import { kv } from "@/lib/kv";
import { parseJson } from "@/lib/ops/util";

const DAY_MS = 24 * 60 * 60 * 1000;
const STATE = "neo:ops:retention-sweep:2026-11";
const BATCH = 500;

export interface SweepRule {
  label: string;
  match: string;
  /** Keys under `match` this rule leaves alone. */
  skip?: (key: string) => boolean;
  fromDays: number;
  toDays: number;
}

export const SWEEP_RULES: SweepRule[] = [
  // The day totals (neo:pz:<integ>:day:...) stay 400 days: organisation reports read them.
  { label: "partner session detail", match: "neo:pz:*", skip: (k) => k.includes(":day:"), fromDays: 400, toDays: 90 },
  { label: "raw activity log", match: "neo:act:log:*", fromDays: 90, toDays: 30 },
  { label: "activity per person", match: "neo:act:u:*", fromDays: 90, toDays: 30 },
  { label: "job run records", match: "neo:ops:job:run:*", fromDays: 60, toDays: 14 },
];

const SHORTEN = `-- shorten-ttl: each KEYS[i] with more than ARGV[1] ms to live loses ARGV[2] ms of it, or goes if nothing is left
local to = tonumber(ARGV[1])
local delta = tonumber(ARGV[2])
local shortened, removed = 0, 0
for _, k in ipairs(KEYS) do
  local t = redis.call('PTTL', k)
  if t > to then
    local n = t - delta
    if n <= 0 then
      redis.call('DEL', k)
      removed = removed + 1
    else
      redis.call('PEXPIRE', k, n)
      shortened = shortened + 1
    end
  end
end
return {shortened, removed}`;

export interface SweepState {
  rule: number;
  cursor: string;
  done: boolean;
  shortened: number;
  removed: number;
  startedAt: number;
  finishedAt?: number;
}

export async function sweepState(): Promise<SweepState | null> {
  return parseJson<SweepState>(await kv.get(STATE));
}

/**
 * Carry the sweep on for up to `budgetMs`. Returns where it stands; once
 * done, it only reads its state.
 */
export async function runRetentionSweep(opts: { budgetMs?: number; rules?: SweepRule[]; now?: () => number } = {}): Promise<SweepState> {
  const rules = opts.rules ?? SWEEP_RULES;
  const clock = opts.now ?? Date.now;
  const started = clock();
  const budget = opts.budgetMs ?? 20_000;
  const state: SweepState = (await sweepState()) ?? { rule: 0, cursor: "0", done: false, shortened: 0, removed: 0, startedAt: started };
  if (state.done) return state;
  while (state.rule < rules.length && clock() - started < budget) {
    const rule = rules[state.rule];
    const [next, keys] = (await kv.scan(state.cursor, { match: rule.match, count: 2000 })) as [string | number, string[]];
    const mine = keys.filter((k) => !rule.skip?.(k));
    for (let i = 0; i < mine.length; i += BATCH) {
      const [s, r] = (await kv.eval(SHORTEN, mine.slice(i, i + BATCH), [String(rule.toDays * DAY_MS), String((rule.fromDays - rule.toDays) * DAY_MS)])) as [number, number];
      state.shortened += Number(s) || 0;
      state.removed += Number(r) || 0;
    }
    state.cursor = String(next);
    if (state.cursor === "0") {
      state.rule++;
      state.cursor = "0";
    }
    await kv.set(STATE, JSON.stringify(state));
  }
  if (state.rule >= rules.length && !state.done) {
    state.done = true;
    state.finishedAt = clock();
    await kv.set(STATE, JSON.stringify(state));
    console.log(`[retention-sweep] done: ${state.shortened} keys given the new expiry, ${state.removed} removed`);
  }
  return state;
}
