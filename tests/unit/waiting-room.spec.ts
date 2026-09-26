import { test, expect } from "@playwright/test";
import {
  KNOCK_GONE_MS,
  REFUSAL_HOLDS_MS,
  clearedForNewSession,
  gateStatus,
  refusalHolds,
  stillWaiting,
} from "../../src/lib/waitingRoom";
import type { RoleAssignment, WaitingRoomEntry } from "../../src/types/event";

/**
 * How long a host's answer at the waiting room lasts.
 *
 * Found in an always-open room: three people admitted once had permanent
 * pre-approved roles, and the queue still held every answer ever given.
 * Someone refused could never knock again.
 */

const now = Date.parse("2026-09-26T15:00:00.000Z");

function entry(
  id: string,
  status: WaitingRoomEntry["status"],
  decidedAt?: number
): WaitingRoomEntry {
  return { id, name: id, requestedAt: now - 120_000, status, decidedAt };
}

function role(identifier: string, over: Partial<RoleAssignment> = {}): RoleAssignment {
  return { identifier, role: "viewer", label: identifier, preApproved: true, ...over };
}

test.describe("a refusal", () => {
  test("reaches the person still knocking", () => {
    const refused = entry("u1", "denied", now - 5_000);
    expect(refusalHolds(refused, now)).toBe(true);
    expect(gateStatus(refused, now)).toBe("denied");
  });

  test("stops answering after a minute, so they can knock again", () => {
    const refused = entry("u1", "denied", now - REFUSAL_HOLDS_MS);
    expect(refusalHolds(refused, now)).toBe(false);
    expect(gateStatus(refused, now)).toBe("not_knocked");
  });

  test("from before decision times were kept does not hold", () => {
    // These are the stuck ones; with no time they must not be forever.
    expect(gateStatus(entry("u1", "denied"), now)).toBe("not_knocked");
  });
});

test.describe("the gate", () => {
  test("lets in the admitted, holds the pending, and knocks the unknown", () => {
    expect(gateStatus(entry("u1", "admitted", now - 3_600_000), now)).toBe("admitted");
    expect(gateStatus(entry("u1", "pending"), now)).toBe("pending");
    expect(gateStatus(undefined, now)).toBe("not_knocked");
  });
});

test.describe("when the room empties", () => {
  test("admissions and refusals end; people still knocking stay", () => {
    const next = clearedForNewSession({
      waitingRoom: [
        entry("in", "admitted", now),
        entry("no", "denied", now),
        entry("knocking", "pending"),
      ],
      roles: [],
    });
    expect(next?.waitingRoom.map((e) => e.id)).toEqual(["knocking"]);
  });

  test("drops the roles the old admit wrote, and nothing else", () => {
    const next = clearedForNewSession({
      waitingRoom: [entry("user_admitted", "admitted", now)],
      roles: [
        role("user_admitted"),
        // Invited with "skip waiting room": not in the queue, must stay.
        role("guest@example.com"),
        // A cohost who once knocked is still a cohost.
        role("user_cohost", { role: "cohost" }),
        // Pre-approved by ticket purchase: stays.
        role("user_ticket", { role: "ticket-holder" as RoleAssignment["role"] }),
      ],
    });
    expect(next?.roles.map((r) => r.identifier)).toEqual([
      "guest@example.com",
      "user_cohost",
      "user_ticket",
    ]);
  });

  test("a cohost who is also an admitted entry keeps the role", () => {
    const next = clearedForNewSession({
      waitingRoom: [entry("user_cohost", "admitted", now)],
      roles: [role("user_cohost", { role: "cohost" })],
    });
    expect(next?.roles).toHaveLength(1);
  });

  test("matches role identifiers case-insensitively, as the gate does", () => {
    const next = clearedForNewSession({
      waitingRoom: [entry("User_Mixed", "admitted", now)],
      roles: [role("user_mixed")],
    });
    expect(next?.roles).toHaveLength(0);
  });

  test("an empty queue is nothing to write", () => {
    expect(clearedForNewSession({ waitingRoom: [], roles: [role("x@y.z")] })).toBeNull();
    expect(
      clearedForNewSession({ waitingRoom: [entry("k", "pending")], roles: [] })
    ).toBeNull();
  });

  test("the room from the report is released", () => {
    // victor4christ's room as it was stored on 2026-09-26.
    const next = clearedForNewSession({
      waitingRoom: [
        entry("streamlab", "admitted"),
        entry("joshbender", "admitted"),
        entry("the_msi", "admitted"),
      ],
      roles: [role("streamlab"), role("joshbender"), role("the_msi")],
    });
    expect(next).toEqual({ waitingRoom: [], roles: [] });
  });
});

test.describe("someone who walked away", () => {
  // The test account sat in a host's list from 14:50 until evening: its
  // app had long stopped knocking, and nothing noticed.
  const entries = [
    entry("waiting", "pending"),
    entry("gone", "pending"),
    entry("never-timed", "pending"),
    entry("in", "admitted", now),
    entry("no", "denied", now),
  ];
  const seen = new Map([
    ["waiting", now - 4_000],
    ["gone", now - KNOCK_GONE_MS],
  ]);

  test("is left out of the host's list; the rest stay", () => {
    expect(stillWaiting(entries, seen, now).map((e) => e.id)).toEqual([
      "waiting",
      "in",
      "no",
    ]);
  });

  test("a few missed knocks on a slow link are not leaving", () => {
    const slow = new Map([["waiting", now - (KNOCK_GONE_MS - 1)]]);
    expect(stillWaiting([entry("waiting", "pending")], slow, now)).toHaveLength(1);
  });
});
