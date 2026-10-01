// src/lib/disconnectReason.ts
//
// LiveKit's reason for a participant leaving, as it arrives on the
// participant_left webhook (ParticipantInfo.disconnect_reason, a number).
// The names are LiveKit's own, from livekit.DisconnectReason in
// @livekit/protocol, copied here because that package is not a direct
// dependency and livekit-server-sdk does not re-export the enum.
//
// What they tell us, roughly:
//   CLIENT_INITIATED   the person pressed Leave (or closed the tab)
//   DUPLICATE_IDENTITY the same account joined again elsewhere
//   PARTICIPANT_REMOVED a host removed them
//   ROOM_DELETED / ROOM_CLOSED  the meeting was ended
//   SIGNAL_CLOSE / CONNECTION_TIMEOUT  their link dropped and never came back
//   SERVER_SHUTDOWN / MIGRATION  LiveKit's side moved or restarted
const NAMES = [
  "UNKNOWN_REASON",
  "CLIENT_INITIATED",
  "DUPLICATE_IDENTITY",
  "SERVER_SHUTDOWN",
  "PARTICIPANT_REMOVED",
  "ROOM_DELETED",
  "STATE_MISMATCH",
  "JOIN_FAILURE",
  "MIGRATION",
  "SIGNAL_CLOSE",
  "ROOM_CLOSED",
  "USER_UNAVAILABLE",
  "USER_REJECTED",
  "SIP_TRUNK_FAILURE",
  "CONNECTION_TIMEOUT",
  "MEDIA_FAILURE",
  "AGENT_ERROR",
] as const;

/** The reason's name, or the number as text when LiveKit adds one we lack. */
export function disconnectReasonName(code: unknown): string {
  if (typeof code === "string" && code.trim()) return code.trim();
  if (typeof code !== "number" || !Number.isInteger(code) || code < 0) return "UNKNOWN_REASON";
  return NAMES[code] ?? `REASON_${code}`;
}

/** True when the person did not choose to go: a dropped link or a cut from the server. */
export function leftInvoluntarily(reason: string): boolean {
  return !["CLIENT_INITIATED", "DUPLICATE_IDENTITY", "PARTICIPANT_REMOVED", "USER_REJECTED"].includes(reason);
}
