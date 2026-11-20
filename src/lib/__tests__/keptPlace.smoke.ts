// Run: npx tsx src/lib/__tests__/keptPlace.smoke.ts
//
// Lists of people keep their order and the reader's place through a
// connection restart (src/components/conference/keptPlace.ts). The scrolling
// itself is tested in a browser (tests/unit/room-layout.spec.ts); this checks
// the order rule and that both lists a host reads the register from use it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { keepOrder } from "../../components/conference/keptPlace";

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log("  ok  " + name);
};
const ids = (l: { identity: string }[]) => l.map((p) => p.identity);
const p = (identity: string) => ({ identity });

t("people stay in the order first seen; newcomers go to the end", () => {
  const seen = new Map<string, number>();
  assert.deepEqual(ids(keepOrder(seen, [p("me"), p("a"), p("b"), p("c")])), ["me", "a", "b", "c"]);
  // A restart: everyone back, in another order, and one new person.
  assert.deepEqual(ids(keepOrder(seen, [p("c"), p("new"), p("me"), p("b"), p("a")])), ["me", "a", "b", "c", "new"]);
  // Someone who left and came back keeps their place.
  keepOrder(seen, [p("me"), p("b")]);
  assert.deepEqual(ids(keepOrder(seen, [p("me"), p("b"), p("a")])), ["me", "a", "b"]);
});

t("the phone grid and the People list both keep order and place", () => {
  const src = (f: string) => readFileSync(path.resolve(__dirname, "../../", f), "utf8");
  for (const f of ["components/conference/MobileParticipantGrid.tsx", "components/ParticipantsPanel.tsx"]) {
    const s = src(f);
    assert.ok(/keepOrder\(seen\.current, /.test(s), f + ": first-seen order");
    assert.ok(/ref=\{kept\.ref\}\s+\{\.\.\.kept\.handlers\}/.test(s), f + ": the scrolling list keeps its place");
    assert.ok(/data-place=\{/.test(s), f + ": each person is marked for it");
  }
});

console.log(`keptPlace: ${n} checks passed`);
