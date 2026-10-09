// src/lib/activityTypes.ts
//
// The activity log's event types (src/lib/activity.ts). Pure data, so client
// components — the Logs page's type picker — can import it without the KV client.

export type AccountMetric = "participants" | "recordingSeconds" | "apiCalls" | "uploadBytes";

interface TypeDef {
  label: string;
  /** Shown under "Most-used features". */
  feature?: boolean;
  /** Counted only: too frequent to keep one log line each. */
  noRaw?: boolean;
  /** A prop whose value is summed alongside the count (seconds, bytes, minutes). */
  amount?: string;
  /** A prop whose value also splits the count ("plan.purchased#free"). */
  splitBy?: string;
  /** What this adds to `account`'s consumption, and by how much. */
  accountMetric?: { metric: AccountMetric; amount?: string };
}

/** Every event type the app records. Pure data — the admin pages read it too. */
export const ACTIVITY_TYPES: Record<string, TypeDef> = {
  "auth.sign_in": { label: "Sign-in" },
  "auth.sign_up": { label: "Sign-up" },
  "admin.sign_in_failed": { label: "Failed admin sign-in" },
  "meeting.created": { label: "Meeting created", feature: true },
  "meeting.started": { label: "Meeting started" },
  "meeting.ended": { label: "Meeting ended", amount: "minutes" },
  "meeting.joined": { label: "Joined a meeting", accountMetric: { metric: "participants" } },
  "recording.started": { label: "Recording started", feature: true },
  "recording.finished": {
    label: "Recording finished",
    amount: "seconds",
    accountMetric: { metric: "recordingSeconds", amount: "seconds" },
  },
  "translation.used": { label: "Translation (person · language · hour)", feature: true },
  "captions.used": { label: "Live captions", feature: true },
  "livestream.started": { label: "Livestream", feature: true },
  "ai.summary": { label: "AI summary", feature: true },
  "api.call": { label: "Developer API call", feature: true, noRaw: true, accountMetric: { metric: "apiCalls" } },
  "group.call": { label: "Group call", feature: true },
  upload: { label: "File upload", feature: true, amount: "bytes", accountMetric: { metric: "uploadBytes", amount: "bytes" } },
  "plan.purchased": { label: "Plan purchased", splitBy: "from", amount: "amountEsp" },
  "plan.downgraded": { label: "Plan downgraded or ended", splitBy: "from" },
};
