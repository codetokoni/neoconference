// src/lib/shareInvite.ts
//
// Invite people to a meeting from the browser: the phone's share menu
// where the browser has one (WhatsApp, KingsChat, SMS…), a copied link
// where it has not (most desktops). Used before joining and in the meeting.

export type InviteOutcome = "shared" | "copied" | "cancelled" | "failed";

/** The address to share: the short one when the meeting's slug is known. */
export function meetingInviteUrl(eventSlug: string | null | undefined): string {
  return eventSlug
    ? window.location.origin + "/" + encodeURIComponent(eventSlug)
    : window.location.href;
}

export async function shareOrCopyInvite(url: string): Promise<InviteOutcome> {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "NeoConference meeting", text: "Join my meeting on NeoConference:", url });
      return "shared";
    } catch (e) {
      // Closed the share menu: nothing more to do. Anything else: copy.
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}
