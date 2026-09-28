import { test, expect } from "@playwright/test";
import {
  addRecordedSeconds,
  egressSeconds,
  nextMonthStart,
  recordedSeconds,
  recordingAllowance,
  rememberEgressOwner,
  resetRecordingUsageMemory,
  usageMonth,
} from "../../src/lib/recordingUsage";

/**
 * Recording hours per month. The pricing sold Pro with 10 and Business
 * with 50, and nothing counted them. Counted against the meeting owner,
 * per calendar month, when each recording finishes.
 */

const now = Date.parse("2026-09-28T16:00:00.000Z");

test.describe("the month", () => {
  test("is the calendar month in UTC", () => {
    expect(usageMonth(now)).toBe("2026-09");
    expect(usageMonth(Date.parse("2026-12-31T23:59:59Z"))).toBe("2026-12");
    expect(nextMonthStart(Date.parse("2026-12-15T00:00:00Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });
});

test.describe("a recording's length", () => {
  test("comes from the file's duration, in nanoseconds, whatever its type", () => {
    const ninety = 90 * 1e9;
    expect(egressSeconds({ fileResults: [{ duration: BigInt(ninety) }] })).toBe(90);
    expect(egressSeconds({ fileResults: [{ duration: String(ninety) }] })).toBe(90);
    expect(egressSeconds({ file: { duration: ninety } })).toBe(90);
  });

  test("falls back to start and end", () => {
    const start = BigInt(now) * BigInt(1e6);
    const end = start + BigInt(600 * 1e9);
    expect(egressSeconds({ startedAt: start, endedAt: end })).toBe(600);
  });

  test("is 0 when LiveKit says nothing", () => {
    expect(egressSeconds(undefined)).toBe(0);
    expect(egressSeconds({})).toBe(0);
  });
});

test.describe("starting a recording", () => {
  const hour = 3600;

  test("is allowed freely under 80% of the cap", () => {
    expect(recordingAllowance(10, 7 * hour, "Pro", now)).toEqual({ allowed: true });
  });

  test("is allowed with a warning from 80%", () => {
    const a = recordingAllowance(10, 8.2 * hour, "Pro", now);
    expect(a.allowed).toBe(true);
    expect("warning" in a && a.warning).toContain("8.2 of this month's 10 recording hours");
    expect("warning" in a && a.warning).toContain("1 October");
  });

  test("is refused at the cap, saying when it resets", () => {
    const a = recordingAllowance(10, 10 * hour, "Pro", now);
    expect(a.allowed).toBe(false);
    expect(!a.allowed && a.message).toContain("10 recording hours on the Pro plan are used up");
    expect(!a.allowed && a.message).toContain("reset on 1 October");
  });

  test("has no cap when the plan has none", () => {
    expect(recordingAllowance(0, 999 * hour, "Enterprise", now)).toEqual({ allowed: true });
  });
});

test.describe("counting", () => {
  test.beforeEach(() => resetRecordingUsageMemory());

  test("adds each recording to its owner's month once", async () => {
    await rememberEgressOwner("EG_1", "user_owner");
    expect((await addRecordedSeconds("EG_1", 1800, now)).counted).toBe(true);
    // LiveKit delivered the webhook again.
    expect((await addRecordedSeconds("EG_1", 1800, now)).reason).toBe("already_counted");
    expect(await recordedSeconds("user_owner", "2026-09")).toBe(1800);
  });

  test("counts against the owner remembered at start, not the fallback", async () => {
    await rememberEgressOwner("EG_2", "user_owner");
    await addRecordedSeconds("EG_2", 60, now, "user_someone_else");
    expect(await recordedSeconds("user_owner", "2026-09")).toBe(60);
    expect(await recordedSeconds("user_someone_else", "2026-09")).toBe(0);
  });

  test("uses the slug's owner for a recording started before owners were remembered", async () => {
    const r = await addRecordedSeconds("EG_OLD", 120, now, "user_owner");
    expect(r.counted).toBe(true);
    expect(await recordedSeconds("user_owner", "2026-09")).toBe(120);
  });

  test("says why when it cannot count", async () => {
    expect((await addRecordedSeconds("EG_3", 60, now)).reason).toBe("owner_unknown");
    expect((await addRecordedSeconds("EG_4", 0, now, "user_owner")).reason).toBe("no_length");
  });
});
