// Run: npx tsx src/lib/__tests__/fitGrid.smoke.ts
//
// The moderator display boards fill the screen with however many people
// are on: one camera fills it, fifty share it, never more than fifty a page.

import assert from "node:assert/strict";
import { PER_PAGE, fitGrid, pageOf } from "../fitGrid";

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log("  ok  " + name);
};

const GAP = 3;
const fits = (count: number, w: number, h: number) => {
  const f = fitGrid(count, w, h);
  assert.ok(f.cols * f.rows >= count, `${count} tiles need room: ${JSON.stringify(f)}`);
  assert.ok(f.cols * f.tileW + (f.cols - 1) * GAP <= w, `too wide: ${count} in ${w}x${h} ${JSON.stringify(f)}`);
  assert.ok(f.rows * f.tileH + (f.rows - 1) * GAP <= h, `too tall: ${count} in ${w}x${h} ${JSON.stringify(f)}`);
  return f;
};

t("one live camera fills the screen (height-limited on a wide screen)", () => {
  const f = fits(1, 1920, 1000);
  assert.deepEqual([f.cols, f.rows], [1, 1]);
  assert.equal(f.tileH, 999); // 1333×999, as tall as the screen allows at 4:3
});

t("two sit side by side; four make a 2×2; tiles shrink as people join", () => {
  assert.deepEqual([fits(2, 1920, 1000).cols, fits(2, 1920, 1000).rows], [2, 1]);
  assert.deepEqual([fits(4, 1920, 1000).cols, fits(4, 1920, 1000).rows], [2, 2]);
  const sizes = [1, 2, 4, 9, 16, 25, 50].map((k) => fits(k, 1920, 1000).tileW);
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] <= sizes[i - 1], `sizes ${sizes}`);
});

t("fifty fit on one 1080p screen without scrolling", () => {
  const f = fits(50, 1920, 1000);
  assert.ok(f.tileW >= 180, JSON.stringify(f));
});

t("for every count up to 50 on several screens: everything fits, and no other column count gives bigger tiles", () => {
  for (const [w, h] of [[1920, 1000], [1280, 640], [375, 700], [3840, 2000]]) {
    for (let k = 1; k <= PER_PAGE; k++) {
      const f = fits(k, w, h);
      for (let cols = 1; cols <= k; cols++) {
        const rows = Math.ceil(k / cols);
        const other = Math.floor(Math.min((w - GAP * (cols - 1)) / cols, ((h - GAP * (rows - 1)) / rows) * (4 / 3)));
        assert.ok(other <= f.tileW, `${k} in ${w}x${h}: ${cols} cols gives ${other} > ${f.tileW}`);
      }
    }
  }
});

t("nothing to show, or no space yet: an empty fit, not a crash", () => {
  assert.equal(fitGrid(0, 1920, 1000).tileW, 0);
  assert.equal(fitGrid(5, 0, 0).tileW, 0);
});

t("pages hold at most 50; a page past the end is the last page", () => {
  const items = Array.from({ length: 120 }, (_, i) => i);
  assert.equal(PER_PAGE, 50);
  assert.deepEqual(pageOf(items, 0).items.length, 50);
  assert.deepEqual(pageOf(items, 2).items, items.slice(100));
  assert.equal(pageOf(items, 9).page, 2);
  assert.equal(pageOf(items, 0).pages, 3);
  assert.deepEqual(pageOf([], 3), { items: [], page: 0, pages: 1 });
});

console.log(`\n${n} checks passed`);
