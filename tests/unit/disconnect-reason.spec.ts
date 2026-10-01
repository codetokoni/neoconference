import { test, expect } from "@playwright/test";
import { disconnectReasonName, leftInvoluntarily } from "../../src/lib/disconnectReason";

/**
 * A meeting "closed" on two devices within a minute and the attendance
 * journal could only say "leave". LiveKit sends why; the journal keeps it.
 */
test("LiveKit's reason numbers read by their names", () => {
  expect(disconnectReasonName(1)).toBe("CLIENT_INITIATED");
  expect(disconnectReasonName(9)).toBe("SIGNAL_CLOSE");
  expect(disconnectReasonName(14)).toBe("CONNECTION_TIMEOUT");
  expect(disconnectReasonName(3)).toBe("SERVER_SHUTDOWN");
  expect(disconnectReasonName(0)).toBe("UNKNOWN_REASON");
});

test("a reason we have no name for is still written down", () => {
  expect(disconnectReasonName(99)).toBe("REASON_99");
  expect(disconnectReasonName(undefined)).toBe("UNKNOWN_REASON");
  expect(disconnectReasonName(-1)).toBe("UNKNOWN_REASON");
  // The JSON form of the webhook may carry the name itself.
  expect(disconnectReasonName("SIGNAL_CLOSE")).toBe("SIGNAL_CLOSE");
});

test("leaving on purpose is told apart from being dropped", () => {
  expect(leftInvoluntarily("CLIENT_INITIATED")).toBe(false);
  expect(leftInvoluntarily("PARTICIPANT_REMOVED")).toBe(false);
  expect(leftInvoluntarily("SIGNAL_CLOSE")).toBe(true);
  expect(leftInvoluntarily("SERVER_SHUTDOWN")).toBe(true);
  expect(leftInvoluntarily("UNKNOWN_REASON")).toBe(true);
});
