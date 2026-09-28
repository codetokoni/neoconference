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

/**
 * What the AI is told when it writes a meeting summary.
 *
 * It used to be asked for an overview, "up to 5 key decisions" and "up to
 * 5 action items" in Markdown. Given thirteen words ("Can you hear me?
 * Yes. Okay. Alright…") it reported "Agreed to move forward with the
 * meeting agenda" — there was no agenda. Asked for decisions, it found
 * some. And the Markdown showed as "### Overview" on the phone and the
 * web, which print the text as it is.
 */
export const SUMMARY_INSTRUCTIONS = [
  "You summarise a meeting from its transcript and chat.",
  "Report only what was actually said. Never infer, assume or invent decisions, action items, agendas or outcomes.",
  "Write plain text, no Markdown: no #, no *, no **.",
  "Use three short sections, each a heading on its own line: Overview, Decisions, Action items.",
  "Overview: one to three sentences on what was discussed.",
  "Decisions and Action items: one per line starting with '• ', only if someone clearly stated one; otherwise write 'None recorded.'",
  "If there is too little to summarise, say so in one sentence under Overview and write 'None recorded.' for the rest.",
].join(" ");

/**
 * A summary as plain text, whatever the model sent: Markdown headings
 * become plain lines, list markers become bullets, emphasis is dropped.
 * The screens print summaries as they are, so "### Overview" or "**x**"
 * would show as typed.
 */
export function plainSummary(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^(\s*)[-*+]\s+/, "$1• ")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/__(.+?)__/g, "$1")
        .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, "$1$2")
        .trimEnd()
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
