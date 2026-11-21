// Run: npx tsx src/lib/__tests__/prayerBeat.smoke.ts
//
// The zone embed's heartbeat schedule (src/app/embed/zone/beatSchedule.ts),
// on a fake clock and a fake document: once on connecting, every 60 s on
// screen, every 3 minutes hidden, at once on coming back, and nothing after
// it is stopped. Each beat is a Vercel function call (~100,000 a day at the
// old 20 s), so the count is the point.

import assert from "node:assert/strict";
import { startBeating } from "../../app/embed/zone/beatSchedule";
import { HIDDEN_PAGE_BEAT_MS, PAGE_BEAT_MS } from "../partners/attendanceMath";

let now = 0;
let nextId = 1;
const timers = new Map<number, { every: number; due: number; fn: () => void }>();
const clock = {
  setInterval(fn: () => void, ms: number) {
    const id = nextId++;
    timers.set(id, { every: ms, due: now + ms, fn });
    return id;
  },
  clearInterval(id: number) {
    timers.delete(id);
  },
};
/** Moves the fake clock on, firing intervals as they fall due. */
function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    const next = [...timers.values()].sort((a, b) => a.due - b.due)[0];
    if (!next || next.due > end) break;
    now = next.due;
    next.due += next.every;
    next.fn();
  }
  now = end;
}

const listeners = new Set<() => void>();
const page = {
  visibilityState: "visible",
  addEventListener: (_: "visibilitychange", fn: () => void) => void listeners.add(fn),
  removeEventListener: (_: "visibilitychange", fn: () => void) => void listeners.delete(fn),
};
function show(state: "visible" | "hidden") {
  page.visibilityState = state;
  for (const fn of listeners) fn();
}

const MIN = 60_000;
let beats = 0;
let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`  ok  ${name}`);
};

assert.equal(PAGE_BEAT_MS, MIN);
assert.equal(HIDDEN_PAGE_BEAT_MS, 3 * MIN);
const stop = startBeating(() => beats++, clock, page);

t("beats at once on connecting, then once a minute on screen", () => {
  assert.equal(beats, 1);
  advance(10 * MIN);
  assert.equal(beats, 11, "10 minutes on screen: 10 beats, not the old 30");
});

t("hidden, it slows to every 3 minutes", () => {
  advance(30_000);
  show("hidden");
  assert.equal(beats, 11, "going hidden does not beat");
  advance(30 * MIN);
  assert.equal(beats, 21, "30 minutes hidden: 10 beats, not the old 90");
  assert.equal(timers.size, 1, "one interval at a time");
});

t("coming back beats at once and returns to once a minute", () => {
  advance(MIN);
  show("visible");
  assert.equal(beats, 22);
  advance(5 * MIN);
  assert.equal(beats, 27);
  assert.equal(timers.size, 1);
});

t("stopped (disconnected, or the timer unmounted), nothing more is sent", () => {
  stop();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
  advance(60 * MIN);
  show("hidden");
  show("visible");
  assert.equal(beats, 27);
});

console.log(`\n${n} checks passed`);
