// Where leaving a meeting goes: "How was the meeting?" (src/lib/meetingFeedback.ts),
// a tap of the stars and words if something did not work, with Rejoin and
// Skip there too. A room with no meeting behind it goes home.
//
// One place for it. The phone layout's Leave used to send people straight to
// "/" with a full page load, which overrode the room's own redirect, so no
// one leaving on a phone was ever asked (2026-11-20: 54 website leaves in
// ordinary meetings in the first hours, no ratings).

export function afterLeaveUrl(slug?: string | null): string {
  return slug ? `/feedback/${encodeURIComponent(slug)}?after=1` : "/";
}

/** Leave the LiveKit room and go to the after-leave page. */
export function leaveMeeting(
  room: { disconnect: () => unknown } | null | undefined,
  slug: string | null | undefined,
  go: (url: string) => void = (url) => {
    window.location.href = url;
  },
): void {
  try {
    void room?.disconnect();
  } catch {
    // Gone already: leaving is still leaving.
  }
  go(afterLeaveUrl(slug));
}
