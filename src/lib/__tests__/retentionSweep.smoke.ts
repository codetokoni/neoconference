// Run: npx tsx src/lib/__tests__/retentionSweep.smoke.ts
//
// The one-off sweep onto the November 2026 retention periods
// (src/lib/ops/retentionSweep.ts): a key still on an old period gets the
// expiry it would have had on the new one, or goes if that has passed; a key
// already on the new period, one with no expiry, the partner day totals and
// anything outside the rules are left alone. It stops at its time budget,
// carries on where it stopped, and does nothing once finished.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

Object.assign(process.env, { KV_REST_API_URL: "https://kv.invalid", KV_REST_API_TOKEN: "t" });
const g = globalThis as typeof globalThis & { __kvTtl?: boolean };
g.__kvTtl = true;

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

const DAY = 24 * 60 * 60 * 1000;
const S = 1000;

async function main() {
  const { kv } = await import("../kv");
  const { runRetentionSweep, sweepState } = await import("../ops/retentionSweep");

  /** A key written `ago` days ago with a TTL of `ttlDays`. */
  const put = async (k: string, ttlDays: number | null, ago: number) => {
    await kv.set(k, "x");
    if (ttlDays != null) await kv.pexpire(k, Math.round((ttlDays - ago) * DAY));
  };
  const left = async (k: string) => Number(await kv.pttl(k));
  const near = (ms: number, days: number) => Math.abs(ms - days * DAY) < 60 * S;

  await put("neo:pz:sess:ps_recent", 400, 10); // 390 days left -> 80
  await put("neo:pz:att:ps_old:id1", 400, 100); // older than 90 days -> gone
  await put("neo:pz:pi_1:day:Africa/Lagos:2026-10-19", 400, 10); // day totals: 400 days
  await put("neo:pz:sess:ps_new", 90, 1); // already on the new period
  await put("neo:pz:pi_1:FALF:cur", null, 0); // no expiry
  await put("neo:act:log:2026-11-02", 90, 5); // -> 25 days left
  await put("neo:act:log:2026-10-08", 90, 30); // 30 days old -> gone
  await put("neo:act:u:user_1", 90, 2); // -> 28
  await put("neo:ops:job:run:run_a", 60, 3); // -> 11
  await put("neo:ops:job:run:run_b", 60, 20); // -> gone
  await put("neo:event:e1", 90, 0); // not covered by any rule

  await t("a budget of nothing does nothing and records nothing", async () => {
    const s = await runRetentionSweep({ budgetMs: 0 });
    assert.equal(s.done, false);
    assert.equal(s.shortened + s.removed, 0);
    assert.ok(near(await left("neo:pz:sess:ps_recent"), 390));
  });

  await t("it stops at its budget and carries on where it stopped", async () => {
    // Each clock read moves 10 s: in a 15 s budget there is time for one scan step.
    let now = 0;
    const clock = () => (now += 10 * S);
    const first = await runRetentionSweep({ budgetMs: 15 * S, now: clock });
    assert.equal(first.done, false);
    assert.equal(first.rule, 1, "the partner rule finished, the activity log not started");
    assert.equal((await sweepState())?.rule, 1);
    assert.ok(near(await left("neo:act:log:2026-11-02"), 85), "not reached yet");
    const rest = await runRetentionSweep({ budgetMs: 60 * S });
    assert.equal(rest.done, true);
  });

  await t("each key gets the expiry it would have had on the new period, or goes", async () => {
    assert.ok(near(await left("neo:pz:sess:ps_recent"), 80));
    assert.equal(await kv.exists("neo:pz:att:ps_old:id1"), 0);
    assert.ok(near(await left("neo:act:log:2026-11-02"), 25));
    assert.equal(await kv.exists("neo:act:log:2026-10-08"), 0);
    assert.ok(near(await left("neo:act:u:user_1"), 28));
    assert.ok(near(await left("neo:ops:job:run:run_a"), 11));
    assert.equal(await kv.exists("neo:ops:job:run:run_b"), 0);
    const s = await sweepState();
    assert.equal(s?.removed, 3);
    assert.equal(s?.shortened, 4);
  });

  await t("day totals, keys already on the new period, keys with no expiry and other keys are left alone", async () => {
    assert.ok(near(await left("neo:pz:pi_1:day:Africa/Lagos:2026-10-19"), 390));
    assert.ok(near(await left("neo:pz:sess:ps_new"), 89));
    assert.equal(await left("neo:pz:pi_1:FALF:cur"), -1);
    assert.ok(near(await left("neo:event:e1"), 90));
  });

  await t("once done it changes nothing, even for a key written on an old period since", async () => {
    await put("neo:pz:sess:ps_late", 400, 0);
    const s = await runRetentionSweep({ budgetMs: 60 * S });
    assert.equal(s.done, true);
    assert.ok(near(await left("neo:pz:sess:ps_late"), 400));
  });

  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
