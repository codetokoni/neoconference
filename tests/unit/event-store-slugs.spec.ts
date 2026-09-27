import { test, expect } from "@playwright/test";
import { eventStore } from "../../src/lib/eventStore";
import type { NeoEvent } from "../../src/types/event";

/**
 * A slug's index entry belongs to the event it points at.
 *
 * Runs against the store's in-memory mode (no KV in unit tests), which
 * shares releaseSlug and the rename rule with the KV path. Each test uses
 * its own slugs because the in-memory store lives for the whole run.
 */

delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const now = new Date().toISOString();
const ev = (id: string, slug: string): NeoEvent =>
  ({ id, slug, livekitRoom: slug, name: slug, ownerUserId: "user_t", state: "ended", createdAt: now, updatedAt: now }) as unknown as NeoEvent;

test.describe("slug index ownership", () => {
  test("deleting a leftover copy keeps the real meeting reachable", async () => {
    // create() overwrites the index, as the old adoption race did: the
    // second record is the one the slug opens.
    await eventStore.create(ev("left-1", "dup-a"));
    await eventStore.create(ev("real-1", "dup-a"));
    expect((await eventStore.bySlug("dup-a"))?.id).toBe("real-1");

    await eventStore.delete("left-1");

    expect((await eventStore.bySlug("dup-a"))?.id).toBe("real-1");
  });

  test("deleting the meeting the slug opens still frees the slug", async () => {
    await eventStore.create(ev("only-1", "solo-a"));
    await eventStore.delete("only-1");
    expect(await eventStore.bySlug("solo-a")).toBeNull();
  });

  test("renaming a leftover copy does not take the real meeting's address", async () => {
    await eventStore.create(ev("left-2", "dup-b"));
    await eventStore.create(ev("real-2", "dup-b"));

    const r = await eventStore.rename("left-2", "dup-b-renamed");

    expect(r.ok).toBe(true);
    expect((await eventStore.bySlug("dup-b"))?.id).toBe("real-2");
    expect((await eventStore.bySlug("dup-b-renamed"))?.id).toBe("left-2");
  });

  test("renaming the real meeting keeps its old address as an alias", async () => {
    await eventStore.create(ev("real-3", "old-c"));
    await eventStore.rename("real-3", "new-c");
    expect((await eventStore.bySlug("old-c"))?.id).toBe("real-3");
    expect((await eventStore.bySlug("new-c"))?.id).toBe("real-3");
  });
});
