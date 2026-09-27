import { test, expect } from "@playwright/test";
import { withoutSupersededSlugs } from "../../src/lib/slugWinners";

const ev = (id: string, slug: string) => ({ id, slug });

test.describe("a list without records whose slug opens another event", () => {
  test("keeps only the event the slug points at", async () => {
    const all = [ev("a", "vortex"), ev("b", "vortex"), ev("c", "vortex"), ev("d", "vortex")];
    const kept = await withoutSupersededSlugs(all, async () => "c");
    expect(kept.map((e) => e.id)).toEqual(["c"]);
  });

  test("does not look up slugs that appear once", async () => {
    const asked: string[] = [];
    const all = [ev("a", "one"), ev("b", "two"), ev("c", "two")];
    const kept = await withoutSupersededSlugs(all, async (slug) => {
      asked.push(slug);
      return "b";
    });
    expect(asked).toEqual(["two"]);
    expect(kept.map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("keeps every copy when the slug points nowhere", async () => {
    // Nothing to prefer, and hiding them all would lose the meeting.
    const all = [ev("a", "gone"), ev("b", "gone")];
    const kept = await withoutSupersededSlugs(all, async () => null);
    expect(kept.map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("hides every copy when the slug belongs to someone else's event", async () => {
    const all = [ev("a", "taken"), ev("b", "taken")];
    const kept = await withoutSupersededSlugs(all, async () => "not-mine");
    expect(kept).toEqual([]);
  });
});
