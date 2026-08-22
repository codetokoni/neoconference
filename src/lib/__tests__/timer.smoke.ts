// Run: npx tsx src/lib/__tests__/timer.smoke.ts
// Pure-module smoke test for the FRS §10 meeting timer state machine.
// No KV, no Next — the transitions are pure so we can exercise every edge
// without any server context.

import assert from "node:assert/strict";
import {
  IDLE_TIMER,
  computeRemaining,
  transitionSet,
  transitionStart,
  transitionPause,
  transitionResume,
  transitionReset,
  transitionAdjust,
  transitionVisibility,
} from "../timer";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("  ok  " + name); };

console.log("timer state machine");

t("idle timer reads as full duration remaining", () => {
  const s = transitionSet(IDLE_TIMER, 60_000);
  assert.equal(s.status, "idle");
  assert.equal(s.durationMs, 60_000);
  assert.equal(computeRemaining(s, 1_000_000), 60_000);
});

t("start begins the countdown; remaining decays with wall clock", () => {
  const s0 = transitionSet(IDLE_TIMER, 10_000);
  const s1 = transitionStart(s0, 100_000);
  assert.equal(s1.status, "running");
  assert.equal(s1.startedAtMs, 100_000);
  assert.equal(computeRemaining(s1, 100_000), 10_000);
  assert.equal(computeRemaining(s1, 105_000), 5_000);
  assert.equal(computeRemaining(s1, 200_000), 0);
});

t("pause captures the remaining value; resume picks up from there", () => {
  const s0 = transitionSet(IDLE_TIMER, 20_000);
  const s1 = transitionStart(s0, 1_000);
  const s2 = transitionPause(s1, 6_000);
  assert.equal(s2.status, "paused");
  assert.equal(s2.remainingAtPauseMs, 15_000);
  assert.equal(computeRemaining(s2, 999_999), 15_000);
  const s3 = transitionResume(s2, 10_000);
  assert.equal(s3.status, "running");
  assert.equal(s3.remainingAtStartMs, 15_000);
  assert.equal(computeRemaining(s3, 15_000), 10_000);
  assert.equal(computeRemaining(s3, 25_000), 0);
});

t("reset returns to full duration but keeps the current duration", () => {
  const s0 = transitionSet(IDLE_TIMER, 30_000);
  const s1 = transitionStart(s0, 0);
  const s2 = transitionPause(s1, 10_000);
  const s3 = transitionReset(s2);
  assert.equal(s3.status, "idle");
  assert.equal(s3.durationMs, 30_000);
  assert.equal(s3.remainingAtStartMs, 30_000);
  assert.equal(s3.remainingAtPauseMs, null);
  assert.equal(s3.startedAtMs, null);
});

t("adjust while idle changes the base duration", () => {
  const s0 = transitionSet(IDLE_TIMER, 60_000);
  const s1 = transitionAdjust(s0, 30_000);
  assert.equal(s1.durationMs, 90_000);
  const s2 = transitionAdjust(s1, -80_000);
  assert.equal(s2.durationMs, 10_000);
  const s3 = transitionAdjust(s2, -50_000); // can't go negative
  assert.equal(s3.durationMs, 0);
});

t("adjust while running rebases the running clock", () => {
  const s0 = transitionSet(IDLE_TIMER, 60_000);
  const s1 = transitionStart(s0, 100_000);
  // At t=130_000 30s have elapsed -> 30s remain. Adjust +15s.
  const s2 = transitionAdjust(s1, 15_000, 130_000);
  assert.equal(s2.status, "running");
  assert.equal(s2.remainingAtStartMs, 45_000);
  assert.equal(s2.startedAtMs, 130_000);
  assert.equal(computeRemaining(s2, 130_000), 45_000);
  assert.equal(computeRemaining(s2, 175_000), 0);
});

t("adjust while paused changes the held value", () => {
  const s0 = transitionSet(IDLE_TIMER, 60_000);
  const s1 = transitionStart(s0, 0);
  const s2 = transitionPause(s1, 20_000); // remaining = 40s
  const s3 = transitionAdjust(s2, -30_000);
  assert.equal(s3.status, "paused");
  assert.equal(s3.remainingAtPauseMs, 10_000);
});

t("visibility toggle is orthogonal to countdown state", () => {
  const s0 = transitionSet(IDLE_TIMER, 5_000, "everyone");
  const s1 = transitionStart(s0, 0);
  const s2 = transitionVisibility(s1, "admins");
  assert.equal(s2.visibility, "admins");
  assert.equal(s2.status, "running");
  assert.equal(s2.startedAtMs, 0);
});

t("clamps: negative duration becomes 0", () => {
  const s = transitionSet(IDLE_TIMER, -5_000);
  assert.equal(s.durationMs, 0);
});

t("clamps: absurd duration is capped at 24h", () => {
  const s = transitionSet(IDLE_TIMER, 100 * 24 * 60 * 60 * 1000);
  assert.equal(s.durationMs, 24 * 60 * 60 * 1000);
});

t("pause is a no-op when not running", () => {
  const s0 = transitionSet(IDLE_TIMER, 10_000);
  const s1 = transitionPause(s0);
  assert.equal(s1.status, "idle");
});

t("resume is a no-op when not paused", () => {
  const s0 = transitionSet(IDLE_TIMER, 10_000);
  const s1 = transitionResume(s0);
  assert.equal(s1.status, "idle");
});

console.log(`\n${n} checks passed`);
