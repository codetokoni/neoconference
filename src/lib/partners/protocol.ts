// src/lib/partners/protocol.ts — the messages between a partner page (the
// widget script, public/widget/v1.js) and the zone embed (/embed/zone).
//
// Every message is { nlm: 1, type, ...fields }. A message without nlm: 1 is
// not ours and is ignored, so a later version can change shapes without an
// old page misreading them. public/widget/v1.js repeats these names: it is a
// plain script, not built from this file.
//
// Parent page -> embed (posted to the embed's exact origin):
//   session  { code }      the one-time code from the partner's backend
//   join                   join with the visitor's current device choices
//   leave                  leave the meeting (the page offers Rejoin)
//
// Embed -> parent page:
//   request-session        "send me a code" — on load, and again when the
//                          meeting session has expired. Carries nothing, so
//                          it is the one message posted to "*": the embed
//                          does not yet know who framed it.
//   ready  { meeting: { title, zoneId }, participant: { name, verified } }
//   waiting { reason: "waiting_room" | "wait_for_host" }
//   joined
//   left   { reason: "left" | "removed" | "opened_in_tab" | "replaced" | "disconnected" }
//   meeting-ended
//   permission-denied { device: "camera" | "microphone" | "media" }
//   prayer-time { seconds, connected, sessionId }   each second in the meeting:
//                          the visitor's counted time in the current prayer session
//   error  { code, message }
// Everything after request-session goes only to the origin the code was
// redeemed for (verified by the server), never to "*".

export const PROTOCOL_VERSION = 1;

export type ParentMessage =
  | { nlm: 1; type: "session"; code: string }
  | { nlm: 1; type: "join" }
  | { nlm: 1; type: "leave" };

export type EmbedEvent =
  | { type: "request-session" }
  | { type: "ready"; meeting: { title: string; zoneId: string }; participant: { name: string; verified: boolean } }
  | { type: "waiting"; reason: "waiting_room" | "wait_for_host" }
  | { type: "joined" }
  | { type: "left"; reason: "left" | "removed" | "opened_in_tab" | "replaced" | "disconnected" }
  | { type: "meeting-ended" }
  | { type: "permission-denied"; device: "camera" | "microphone" | "media" }
  | { type: "prayer-time"; seconds: number; connected: boolean; sessionId: string | null }
  | { type: "error"; code: string; message: string };

/** A message from the parent page, or null when it is not one of ours. */
export function parseParentMessage(data: unknown): ParentMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.nlm !== PROTOCOL_VERSION) return null;
  if (m.type === "session") return typeof m.code === "string" && m.code.length <= 200 ? { nlm: 1, type: "session", code: m.code } : null;
  if (m.type === "join" || m.type === "leave") return { nlm: 1, type: m.type };
  return null;
}
