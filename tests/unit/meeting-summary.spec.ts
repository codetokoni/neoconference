import { test, expect } from "@playwright/test";
import {
  MAX_SUMMARY_INPUT_CHARS,
  chatForSummary,
  summaryContext,
} from "../../src/lib/meetingSummary";
import type { ChatMessage } from "../../src/types/event";

/**
 * What an AI meeting summary is written from.
 *
 * Found by the lint sweep: the route read m.from?.name and m.message, but
 * stored chat has name and text, so every line reached the model as
 * "guest: " — and the transcript lookup used the meeting id, which
 * transcripts are not indexed by.
 */

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: "m1",
  userId: "user_1",
  name: "Ada",
  text: "hello",
  ts: "2026-09-27T09:00:00.000Z",
  ...over,
});

test.describe("the chat a summary sees", () => {
  test("is who said what, from the fields messages are stored with", () => {
    expect(
      chatForSummary([
        msg({ name: "Ada", text: "Budget is approved." }),
        msg({ id: "m2", name: "Bo", text: "I'll send the deck." }),
      ])
    ).toBe("Ada: Budget is approved.\nBo: I'll send the deck.");
  });

  test("leaves out direct messages, which only two people saw", () => {
    expect(
      chatForSummary([
        msg({ text: "public" }),
        msg({ id: "m2", text: "just for you", toUserId: "user_2" }),
      ])
    ).toBe("Ada: public");
  });

  test("skips empty messages (attachments only) and names the nameless", () => {
    expect(chatForSummary([msg({ text: "  " }), msg({ id: "m2", name: "", text: "hi" })])).toBe(
      "guest: hi"
    );
  });
});

test.describe("the whole input", () => {
  const ev = { name: "Weekly sync", slug: "weekly-sync", description: "Team" };

  test("carries the transcript and the chat under their headings", () => {
    const ctx = summaryContext(ev, [msg({ text: "Ship Friday." })], [
      { text: "We agreed to ship on Friday." },
    ]);
    expect(ctx).toContain("EVENT: Weekly sync");
    expect(ctx).toContain("DESCRIPTION: Team");
    expect(ctx).toContain("TRANSCRIPT:\nWe agreed to ship on Friday.");
    expect(ctx).toContain("CHAT:\nAda: Ship Friday.");
  });

  test("joins several recordings' transcripts in order", () => {
    const ctx = summaryContext(ev, [], [{ text: "Part one." }, { text: "Part two." }]);
    expect(ctx).toContain("TRANSCRIPT:\nPart one.\n\nPart two.");
  });

  test("with nothing said is too short to summarise (the route refuses under 50)", () => {
    expect(summaryContext({ name: "x", slug: "x" }, [], []).trim().length).toBeLessThan(50);
  });

  test("is capped", () => {
    const long = "x".repeat(MAX_SUMMARY_INPUT_CHARS + 500);
    expect(summaryContext(ev, [], [{ text: long }]).length).toBe(MAX_SUMMARY_INPUT_CHARS);
  });
});
