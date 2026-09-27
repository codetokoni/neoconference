import { test, expect } from "@playwright/test";
import { toPublicView, type NeoEvent } from "../../src/types/event";

// The view public pages render, and anyone can load. A transcript artifact
// carries the meeting word for word; it leaked through here to the public
// replay page.
test("the public view of a meeting carries no transcript or chapters", () => {
  const ev = {
    id: "e1",
    slug: "hsmanagers",
    name: "hsmanagers",
    state: "ended",
    password: "secret",
    recordings: [
      { key: "recordings/u/hsmanagers/a.mp4", kind: "mp4", createdAt: "2026-09-27T00:00:00Z" },
      { key: "transcript:j1", kind: "transcript", label: "Every word said", createdAt: "2026-09-27T00:00:00Z" },
    ],
    chapters: [{ id: "c1", startSec: 0, endSec: 60, label: "Opening", summary: "What was said", source: "ai" }],
  } as unknown as NeoEvent;

  const view = toPublicView(ev);

  expect(view.recordings.map((r) => r.kind)).toEqual(["mp4"]);
  expect(JSON.stringify(view)).not.toContain("Every word said");
  expect(view.chapters).toBeUndefined();
  expect(JSON.stringify(view)).not.toContain("secret");
});
