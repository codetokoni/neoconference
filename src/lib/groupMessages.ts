// src/lib/groupMessages.ts
//
// What the group API's error codes mean, in words a person can act on.
// Shared by every group screen so the same refusal always reads the same.

const MESSAGES: Record<string, string> = {
  unauthorized: "Please sign in again.",
  forbidden: "Your role in this group doesn't allow that.",
  insufficient_rank: "Your role in this group doesn't allow that.",
  not_found: "This group no longer exists, or you are not in it.",
  invalid_name: "Give the group a name (up to 80 characters).",
  invalid_description: "The description is too long (500 characters at most).",
  invalid_icon: "The icon must be an https:// image link.",
  invalid_settings: "Retry interval must be 1–60 minutes and attempts 1–10.",
  invalid_members: "One of those entries isn't a valid email address or KingsChat handle.",
  no_members: "Enter an email address to add.",
  too_many_at_once: "Add at most 50 people at a time.",
  too_many_members: "A group can have at most 500 members.",
  user_not_found: "No NeoConference account uses that email. Send them the invite link instead.",
  not_member: "That person is no longer in the group.",
  cannot_target_owner: "The owner can't be changed or removed.",
  cannot_manage_self: "You can't change your own role.",
  owner_must_transfer: "Make someone else the owner before you leave.",
  confirmation_mismatch: "The name you typed doesn't match.",
  not_attendee: "Some of the people chosen weren't in this meeting.",
  not_started: "This meeting hasn't started yet, so there is no one to add.",
  invite_expired: "This invite link has expired. Ask for a new one.",
  event_not_found: "That meeting no longer exists.",
  invalid_title: "Give the meeting a title (up to 120 characters).",
  invalid_time: "Choose a time in the future.",
  invalid_duration: "The meeting must last between 5 and 480 minutes.",
  invalid_timezone: "Choose a timezone from the list.",
  invalid_recurrence: "Check the repeat: every 1–12, and 1–52 meetings or a last date after the first.",
  invalid_password: "The password can be up to 80 characters.",
  invalid_scope: "Choose this meeting, or this and the following ones.",
  lifetime_meetings_exhausted: "The group owner's Free plan has no meetings left. Ask the owner to upgrade.",
  plan_member_limit: "This group has as many members as its owner's plan allows.",
  meeting_not_editable: "This meeting has already started, ended or been cancelled, so it can't be changed.",
  meeting_not_open: "This meeting is over, so no one more can be added.",
  not_group_meeting: "This isn't a group meeting.",
  group_has_no_owner: "This group has no owner, so it can't hold meetings.",
};

/** Refusals that an upgrade of the owner's plan would lift. */
const PLAN_LIMIT_CODES = ["lifetime_meetings_exhausted", "plan_member_limit"];

/** Whether a message shown to someone is one of the plan limits (so an upgrade link fits). */
export function isPlanLimitMessage(text: string): boolean {
  return PLAN_LIMIT_CODES.some((c) => MESSAGES[c] === text);
}

export function groupErrorMessage(code: string | undefined | null): string {
  return (code && MESSAGES[code]) || "Something went wrong. Please try again.";
}

/** Reads `{ error }` from a failed response and turns it into a sentence. */
export async function groupErrorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return groupErrorMessage(body.error);
}
