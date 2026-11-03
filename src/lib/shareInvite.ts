// src/lib/shareInvite.ts
//
// Invite people to a meeting from the browser: the phone's share menu
// where the browser has one (WhatsApp, KingsChat, SMS…), a copied link
// where it has not (most desktops). Used before joining and in the meeting.

import { BRAND } from "@/lib/brand";
import { APP_STORE_URL } from "@/lib/appGate";
export type InviteOutcome = "shared" | "copied" | "cancelled" | "failed";

/**
 * What an invite says: the meeting link, then where to get the app, so the
 * people it is sent to can pass the download on too (owner, 2026-11-03).
 */
export function inviteMessage(url: string): string {
  return `Join my meeting on ${BRAND.name}:\n${url}\n\nGet the ${BRAND.name} app: ${APP_STORE_URL}`;
}

/** The address to share: the short one when the meeting's slug is known. */
export function meetingInviteUrl(eventSlug: string | null | undefined): string {
  return eventSlug
    ? window.location.origin + "/" + encodeURIComponent(eventSlug)
    : window.location.href;
}

export async function shareOrCopyInvite(url: string): Promise<InviteOutcome> {
  const message = inviteMessage(url);
  if (typeof navigator.share === "function") {
    try {
      // Both links in the text, in this order: given a `url` as well, some
      // apps put it last, after the download link.
      await navigator.share({ title: `${BRAND.name} meeting`, text: message });
      return "shared";
    } catch (e) {
      // Closed the share menu: nothing more to do. Anything else: copy.
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
    }
  }
  try {
    await navigator.clipboard.writeText(message);
    return "copied";
  } catch {
    return "failed";
  }
}
