import { test, expect } from "@playwright/test";
import {
  decideSweep,
  inProgressSince,
  inferredEndedAt,
  canEnd,
  rejoinDropsToAttendee,
  reopensOnJoin,
  isInProgress,
  sweepStaleMeetings,
  DEFAULT_GRACE_MS,
  EARLY_START_MS,
  endsWhenRoomFinishes,
  goesLiveWhenRoomStarts,
} from "../../src/lib/meetingLifecycle";
import type { NeoEvent, EventState } from "../../src/types/event";

/**
 * Ending meetings that already ended.
 *
 * Written from the production account, where meetings were still marked
 * live 128 days after they finished and the mobile dashboard was offering
 * them as today's meetings.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.parse("2026-09-24T19:00:00.000Z");

function ev(over: Partial<NeoEvent> & { slug: string; state: EventState }): NeoEvent {
  return {
    id: over.id ?? over.slug,
    name: over.slug,
    ownerUserId: "user_1",
    visibility: "unlisted",
    waitingRoomEnabled: false,
    livekitRoom: over.slug,
    roles: [],
    waitingRoom: [],
    createdAt: new Date(now - 30 * DAY).toISOString(),
    updatedAt: new Date(now - 2 * HOUR).toISOString(),
    ...over,
  } as NeoEvent;
}

test.describe("which meetings are over", () => {
  test("a room LiveKit no longer has, open for months, is over", () => {
    const stale = ev({
      slug: "orbit-o03c",
      state: "live",
      startedAt: new Date(now - 128 * DAY).toISOString(),
    });

    const decision = decideSweep({
      events: [stale],
      activeRooms: new Set<string>(),
      now,
    });

    expect(decision.end.map((e) => e.slug)).toEqual(["orbit-o03c"]);
  });

  test("an always-open room that has sat empty for weeks is not over", () => {
    // A personal room is empty most of the time. The sweep was ending it,
    // and after that its owner rejoined as an attendee.
    const personal = ev({
      slug: "victor4christ",
      state: "live",
      isPermanent: true,
      startedAt: new Date(now - 30 * DAY).toISOString(),
    });
    const ordinary = ev({
      slug: "orbit-o03c",
      state: "live",
      startedAt: new Date(now - 30 * DAY).toISOString(),
    });

    const decision = decideSweep({
      events: [personal, ordinary],
      activeRooms: new Set<string>(),
      now,
    });

    expect(decision.end.map((e) => e.slug)).toEqual(["orbit-o03c"]);
  });

  test("a 'waiting' meeting is in progress too", () => {
    // The second half of the bug: room_finished only transitioned from
    // 'live', so a meeting whose attendees were still in the waiting room
    // when the room closed could never be ended by the webhook at all.
    expect(isInProgress("waiting")).toBe(true);
    expect(isInProgress("live")).toBe(true);
    expect(isInProgress("ended")).toBe(false);
    expect(isInProgress("scheduled")).toBe(false);

    const waiting = ev({
      slug: "hsmanagers",
      state: "waiting",
      startedAt: new Date(now - 7 * DAY).toISOString(),
    });

    const decision = decideSweep({
      events: [waiting],
      activeRooms: new Set(),
      now,
    });

    expect(decision.end.map((e) => e.slug)).toEqual(["hsmanagers"]);
  });

  test("a meeting LiveKit still has is left alone", () => {
    const running = ev({
      slug: "standup",
      state: "live",
      startedAt: new Date(now - 30 * DAY).toISOString(),
    });

    const decision = decideSweep({
      events: [running],
      activeRooms: new Set(["standup"]),
      now,
    });

    expect(decision.end).toEqual([]);
    expect(decision.stillActive.map((e) => e.slug)).toEqual(["standup"]);
  });

  test("room names match regardless of case", () => {
    const running = ev({ slug: "Sendforth", state: "live", livekitRoom: "Sendforth" });
    const decision = decideSweep({
      events: [running],
      activeRooms: new Set(["sendforth"]),
      now,
    });
    expect(decision.stillActive.map((e) => e.slug)).toEqual(["Sendforth"]);
  });

  test("a meeting opened minutes ago is not ended before its room exists", () => {
    // /api/events/[id]/start marks a meeting live, and LiveKit does not
    // create the room until the first participant connects. Without the
    // grace period the sweep would end a meeting seconds after someone
    // opened it.
    const justStarted = ev({
      slug: "about-to-begin",
      state: "live",
      startedAt: new Date(now - 30 * 1000).toISOString(),
    });

    const decision = decideSweep({
      events: [justStarted],
      activeRooms: new Set(),
      now,
    });

    expect(decision.end).toEqual([]);
    expect(decision.tooRecent.map((e) => e.slug)).toEqual(["about-to-begin"]);
  });

  test("the grace period is an hour, not a day", () => {
    const twoHours = ev({
      slug: "two-hours",
      state: "live",
      startedAt: new Date(now - 2 * HOUR).toISOString(),
    });

    expect(DEFAULT_GRACE_MS).toBe(HOUR);
    const decision = decideSweep({
      events: [twoHours],
      activeRooms: new Set(),
      now,
    });
    expect(decision.end.map((e) => e.slug)).toEqual(["two-hours"]);
  });

  test("a meeting with no usable timestamp is never ended on a guess", () => {
    const undated = ev({ slug: "undated", state: "live" });
    (undated as { updatedAt?: string }).updatedAt = "";

    const decision = decideSweep({
      events: [undated],
      activeRooms: new Set(),
      now,
    });

    expect(decision.end).toEqual([]);
    expect(decision.tooRecent.map((e) => e.slug)).toEqual(["undated"]);
  });

  test("startedAt is preferred, updatedAt is the fallback", () => {
    const edited = ev({
      slug: "edited",
      state: "live",
      startedAt: new Date(now - 40 * DAY).toISOString(),
      // Renaming it yesterday does not mean the meeting is still going.
      updatedAt: new Date(now - 1 * HOUR).toISOString(),
    });

    expect(inProgressSince(edited)).toBe(Date.parse(edited.startedAt!));
    const decision = decideSweep({
      events: [edited],
      activeRooms: new Set(),
      now,
    });
    expect(decision.end.map((e) => e.slug)).toEqual(["edited"]);
  });

  test("already-ended meetings are not reconsidered", () => {
    const done = ev({ slug: "done", state: "ended" });
    const archived = ev({ slug: "archived", state: "archived" });
    const scheduled = ev({ slug: "later", state: "scheduled" });

    const decision = decideSweep({
      events: [done, archived, scheduled],
      activeRooms: new Set(),
      now,
    });

    expect(decision.end).toEqual([]);
    expect(decision.stillActive).toEqual([]);
    expect(decision.tooRecent).toEqual([]);
  });
});

test.describe("the end time we record", () => {
  test("is the last moment we knew something, not now", () => {
    // We do not know when the room actually closed — that is exactly what
    // the missing webhook would have carried. Claiming a meeting from May
    // ended today would be worse than admitting to the last known moment.
    const stale = ev({
      slug: "stale",
      state: "live",
      updatedAt: new Date(now - 128 * DAY).toISOString(),
    });
    expect(inferredEndedAt(stale)).toBe(stale.updatedAt);
  });

  test("an existing endedAt is never overwritten", () => {
    const already = ev({
      slug: "already",
      state: "live",
      endedAt: new Date(now - 5 * DAY).toISOString(),
    });
    expect(inferredEndedAt(already)).toBe(already.endedAt);
  });
});

test.describe("the sweep as a whole", () => {
  test("ends the finished ones and reports what it did", async () => {
    const ended: string[] = [];
    const summary = await sweepStaleMeetings({
      listAll: async () => [
        ev({ slug: "gone", state: "live", startedAt: new Date(now - 30 * DAY).toISOString() }),
        ev({ slug: "running", state: "live", startedAt: new Date(now - 30 * DAY).toISOString() }),
        ev({ slug: "done", state: "ended" }),
      ],
      listActiveRooms: async () => ["running"],
      endMeeting: async (e) => {
        ended.push(e.slug);
      },
      now,
    });

    expect(ended).toEqual(["gone"]);
    expect(summary).toMatchObject({
      ok: true,
      scanned: 2,
      ended: 1,
      stillActive: 1,
      tooRecent: 0,
      failed: 0,
      endedSlugs: ["gone"],
    });
  });

  test("a LiveKit failure ends nothing at all", async () => {
    // The dangerous failure: treating "could not ask" as "no rooms are
    // active" would end every meeting on the account at once.
    const ended: string[] = [];
    const summary = await sweepStaleMeetings({
      listAll: async () => [
        ev({ slug: "live-1", state: "live", startedAt: new Date(now - 30 * DAY).toISOString() }),
        ev({ slug: "live-2", state: "live", startedAt: new Date(now - 30 * DAY).toISOString() }),
      ],
      listActiveRooms: async () => {
        throw new Error("livekit unreachable");
      },
      endMeeting: async (e) => {
        ended.push(e.slug);
      },
      now,
    });

    expect(ended).toEqual([]);
    expect(summary.ok).toBe(false);
    expect(summary.ended).toBe(0);
    expect(summary.error).toContain("livekit");
  });

  test("LiveKit is not asked when nothing is in progress", async () => {
    let asked = false;
    const summary = await sweepStaleMeetings({
      listAll: async () => [ev({ slug: "done", state: "ended" })],
      listActiveRooms: async () => {
        asked = true;
        return [];
      },
      endMeeting: async () => {},
      now,
    });

    expect(asked).toBe(false);
    expect(summary).toMatchObject({ ok: true, scanned: 0, ended: 0 });
  });

  test("one failed write does not stop the others", async () => {
    const ended: string[] = [];
    const summary = await sweepStaleMeetings({
      listAll: async () => [
        ev({ slug: "first", state: "live", startedAt: new Date(now - 30 * DAY).toISOString() }),
        ev({ slug: "second", state: "live", startedAt: new Date(now - 30 * DAY).toISOString() }),
      ],
      listActiveRooms: async () => [],
      endMeeting: async (e) => {
        if (e.slug === "first") throw new Error("kv write failed");
        ended.push(e.slug);
      },
      now,
    });

    expect(ended).toEqual(["second"]);
    expect(summary).toMatchObject({ ok: true, ended: 1, failed: 1 });
  });
});

test.describe("always-open rooms", () => {
  test("can never be over; ordinary meetings can", () => {
    expect(canEnd({ isPermanent: true })).toBe(false);
    expect(canEnd({ isPermanent: false })).toBe(true);
    expect(canEnd({})).toBe(true);
  });

  test("rejoining an ended meeting drops to attendee, as FRS §7.4 says", () => {
    expect(rejoinDropsToAttendee({ state: "ended" })).toBe(true);
    expect(rejoinDropsToAttendee({ state: "live" })).toBe(false);
  });

  test("but not in an always-open room, even one already marked ended", () => {
    // The webhook marked personal rooms 'ended' every time they emptied,
    // before this rule existed. Their owners must get host back on rejoin
    // without anyone having to repair the stored state first.
    expect(rejoinDropsToAttendee({ state: "ended", isPermanent: true })).toBe(
      false
    );
  });

  test("one already stored as ended is reopened when someone joins", () => {
    // Production: victor4christ's room had been 'ended' since at least
    // 2026-09-24 22:18, and every room_finished since said so.
    expect(reopensOnJoin({ state: "ended", isPermanent: true })).toBe(true);
  });

  test("nothing else is reopened by joining", () => {
    expect(reopensOnJoin({ state: "live", isPermanent: true })).toBe(false);
    // A deleted room stays deleted, permanent or not.
    expect(reopensOnJoin({ state: "archived", isPermanent: true })).toBe(false);
    // An ordinary meeting that ended stays ended (FRS §7.4).
    expect(reopensOnJoin({ state: "ended" })).toBe(false);
    expect(reopensOnJoin({ state: "ended", isPermanent: false })).toBe(false);
  });
});

test.describe("meetings joined without pressing Start", () => {
  // Found on knock-test: made from the phone's Start, run for half an hour,
  // and still 'scheduled' — so room_finished refused to end it, as it had
  // for 17 of the last 43 meetings it turned away.
  const at = (ms: number) => new Date(now + ms).toISOString();

  test("one with no set time goes live when its room starts, and ends when it empties", () => {
    const m = { state: "scheduled" as EventState };
    expect(goesLiveWhenRoomStarts(m, now)).toBe(true);
    expect(endsWhenRoomFinishes(m, now)).toBe(true);
  });

  test("one that is due goes live, including a few minutes early", () => {
    expect(goesLiveWhenRoomStarts({ state: "scheduled", scheduledAt: at(-HOUR) }, now)).toBe(true);
    expect(goesLiveWhenRoomStarts({ state: "scheduled", scheduledAt: at(EARLY_START_MS) }, now)).toBe(true);
  });

  test("a look at tomorrow's room today does not start or end tomorrow's meeting", () => {
    // Otherwise the host's leaving would end it, and they would come back
    // tomorrow as an attendee.
    const tomorrow = { state: "scheduled" as EventState, scheduledAt: at(DAY) };
    expect(goesLiveWhenRoomStarts(tomorrow, now)).toBe(false);
    expect(endsWhenRoomFinishes(tomorrow, now)).toBe(false);
  });

  test("a host who came very early and stayed through the start still ends it", () => {
    // The room started too early to go live and never started again.
    const due = { state: "scheduled" as EventState, scheduledAt: at(-10 * 60 * 1000) };
    expect(endsWhenRoomFinishes(due, now)).toBe(true);
  });

  test("an always-open room is never ended, whatever its state", () => {
    expect(endsWhenRoomFinishes({ state: "live", isPermanent: true }, now)).toBe(false);
    expect(endsWhenRoomFinishes({ state: "scheduled", isPermanent: true }, now)).toBe(false);
  });

  test("only scheduled meetings are started; an ended one stays ended", () => {
    for (const state of ["live", "waiting", "ended", "archived", "replay"] as EventState[]) {
      expect(goesLiveWhenRoomStarts({ state }, now)).toBe(false);
    }
    expect(endsWhenRoomFinishes({ state: "ended" }, now)).toBe(false);
    expect(endsWhenRoomFinishes({ state: "live" }, now)).toBe(true);
    expect(endsWhenRoomFinishes({ state: "waiting" }, now)).toBe(true);
  });

  test("a garbled scheduled time counts as no time, not as never", () => {
    expect(goesLiveWhenRoomStarts({ state: "scheduled", scheduledAt: "soon" }, now)).toBe(true);
  });
});
