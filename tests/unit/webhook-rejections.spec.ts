import { test, expect } from "@playwright/test";
import {
  recordWebhookRejection,
  readWebhookRejections,
  __resetInMemoryWebhookMetrics,
  __inMemoryRejectionCount,
} from "../../src/lib/webhookMetrics";

/**
 * Recording the webhooks that arrived and changed nothing.
 *
 * room_finished had fired 224 times with 7 rooms still open and no record
 * of which 7 or why — the counters are bumped before the handler runs, so
 * a rejected event looks exactly like one that ended a meeting.
 *
 * These run against the in-memory fallback, which is what the library uses
 * when KV is not configured. That is the path a test gets, and it has to
 * behave the same way the Redis path does.
 */

test.beforeEach(() => {
  __resetInMemoryWebhookMetrics();
});

test("a rejection keeps the room and the reason", async () => {
  await recordWebhookRejection({
    event: "room_finished",
    room: "orbit-o03c",
    reason: "not_in_progress",
    state: "ended",
    eventId: "evt_1",
  });

  const [entry] = await readWebhookRejections();
  expect(entry).toMatchObject({
    event: "room_finished",
    room: "orbit-o03c",
    reason: "not_in_progress",
    state: "ended",
    eventId: "evt_1",
  });
  // Without a timestamp the list cannot answer "is this still happening?",
  // which is the whole question it exists for.
  expect(entry.atMs).toBeGreaterThan(0);
});

test("newest first", async () => {
  await recordWebhookRejection({ event: "room_finished", room: "first", reason: "event_not_found" });
  await recordWebhookRejection({ event: "room_finished", room: "second", reason: "event_not_found" });

  const rooms = (await readWebhookRejections()).map((r) => r.room);
  expect(rooms).toEqual(["second", "first"]);
});

test("the store is capped, not just the read", async () => {
  // A diagnostic, not an audit log. An unbounded list is a slow leak that
  // nobody notices until it matters.
  //
  // Asserted on the store rather than the read: readWebhookRejections
  // caps its result on the way out, so checking only that would pass
  // against a list growing forever and being read 50 at a time. The first
  // version of this test did exactly that and survived deleting the trim.
  for (let i = 0; i < 60; i += 1) {
    await recordWebhookRejection({
      event: "room_finished",
      room: "room-" + i,
      reason: "event_not_found",
    });
  }

  expect(__inMemoryRejectionCount()).toBe(50);

  const all = await readWebhookRejections(1000);
  expect(all.length).toBe(50);
  expect(all[0].room).toBe("room-59");
  expect(all[all.length - 1].room).toBe("room-10");
});

test("a limit smaller than the cap is honoured", async () => {
  for (let i = 0; i < 5; i += 1) {
    await recordWebhookRejection({
      event: "room_finished",
      room: "room-" + i,
      reason: "no_room",
    });
  }

  expect((await readWebhookRejections(2)).map((r) => r.room)).toEqual([
    "room-4",
    "room-3",
  ]);
});

test("a room_finished with no room name still records something", async () => {
  // The one case with nothing to identify it. It is still worth a row:
  // "LiveKit sent room_finished without a room" is a different problem
  // from "we have never seen one", and silence cannot tell them apart.
  await recordWebhookRejection({
    event: "room_finished",
    room: "",
    reason: "no_room",
  });

  const [entry] = await readWebhookRejections();
  expect(entry).toMatchObject({ reason: "no_room", room: "" });
});

test("reading an empty list is not an error", async () => {
  expect(await readWebhookRejections()).toEqual([]);
});
