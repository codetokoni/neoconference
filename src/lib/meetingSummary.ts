// src/lib/meetingSummary.ts
//
// What an AI meeting summary is written from.
//
// It used to be written from almost nothing. The chat lines were read as
// m.from?.name and m.message, but stored messages have `name` and `text`,
// so every line reached the model as "guest: " — and the transcript was
// looked up by the meeting's id, while transcripts are indexed by the
// recording they came from, so it was never found. Kept here, apart from
// the route, so a test pins the shape.

import type { ChatMessage, NeoEvent } from "@/types/event";

export const MAX_SUMMARY_INPUT_CHARS = 60000;

/**
 * The chat as the summary sees it: one "name: text" line per message.
 *
 * Direct messages are left out. They were visible only to the two people
 * in them, and the summary is read by the host.
 */
export function chatForSummary(messages: ChatMessage[]): string {
  return messages
    .filter((m) => !m.toUserId && typeof m.text === "string" && m.text.trim())
    .map((m) => (m.name?.trim() || "guest") + ": " + m.text.trim())
    .join("\n");
}

/** The whole input for the model, capped at MAX_SUMMARY_INPUT_CHARS. */
export function summaryContext(
  ev: Pick<NeoEvent, "name" | "slug" | "description">,
  chat: ChatMessage[],
  transcripts: Array<{ text: string }>
): string {
  const transcriptText = transcripts.map((t) => t.text).join("\n\n");
  const chatLines = chatForSummary(chat);
  let context = "EVENT: " + (ev.name || ev.slug) + "\n";
  if (ev.description) context += "DESCRIPTION: " + ev.description + "\n";
  if (transcriptText) context += "\nTRANSCRIPT:\n" + transcriptText + "\n";
  if (chatLines) context += "\nCHAT:\n" + chatLines + "\n";
  return context.length > MAX_SUMMARY_INPUT_CHARS
    ? context.slice(0, MAX_SUMMARY_INPUT_CHARS)
    : context;
}
