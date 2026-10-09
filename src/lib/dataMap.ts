// src/lib/dataMap.ts
//
// Where a person's data lives, and what happens to each place when they ask
// for a copy (export) or for their account to be deleted (erase).
//
// Built by reading every KV write and R2 put in the app (October 2026). Each
// entry is one location. `onDelete`:
//
//   delete     removed when the deletion is completed
//   anonymise  the record stays (it belongs to someone else's meeting or
//              group, or must be kept); the person's id, name and email are
//              replaced by "Deleted user" / a pseudonym
//   keep       kept, with the reason in `why` (legal, security, or not
//              linked to the account at all)
//   expire     short-lived; gone on its own within `ttl`
//
// `exported`: true = in "Download my data"; "summary" = described without
// the secret or third-party parts; false = not exported (why says so).
//
// `erasedBy` names the step in src/lib/dataGov/erase.ts that handles it, so
// the smoke test can check that every delete/anonymise location has one.
// `pending` = a store another admin phase is adding; its step is wired once
// that phase is on main (see the note in each).
//
// Nothing here is read at run time to decide what to delete — erase.ts is
// the code. This is the map an administrator (and the test) checks it by,
// and what /admin/data shows.

export type DataStore = "clerk" | "kv" | "r2";
export type OnDelete = "delete" | "anonymise" | "keep" | "expire";

export interface DataLocation {
  id: string;
  store: DataStore;
  /** Key pattern, Clerk field or R2 prefix. <uid> = Clerk user id. */
  pattern: string;
  /** What it holds. */
  holds: string;
  /** The personal data in it. */
  personal: string;
  exported: boolean | "summary";
  onDelete: OnDelete;
  why: string;
  ttl?: string;
  /** The erase step that handles it (src/lib/dataGov/erase.ts). */
  erasedBy?: string;
  /** Not on main yet: which admin phase adds it. */
  pending?: string;
  /** Something the author was not sure of; listed in the PR. */
  unsure?: string;
}

export const DATA_MAP: DataLocation[] = [
  /* --------------------------------- Clerk --------------------------------- */
  {
    id: "clerk.user",
    store: "clerk",
    pattern: "Clerk user <uid>: names, username, email addresses, image, sign-in methods, externalId (kc:<id> / neomail:<sub>)",
    holds: "The account itself",
    personal: "Name, email addresses, profile image, sign-in history, linked KingsChat / NeoEmail ids",
    exported: true,
    onDelete: "delete",
    why: "The account. Deleted last, so a failure part-way leaves an account that can still be found and finished.",
    erasedBy: "clerk",
  },
  {
    id: "clerk.publicMetadata",
    store: "clerk",
    pattern: "publicMetadata: plan, planExpiresAt, role, meetingsCreated, kingschat {id, username}, neoemail {sub, email}, neoEventId/neoEventSlug/neoRole (invitations)",
    holds: "Plan, app role, linked accounts",
    personal: "KingsChat username, NeoEmail address",
    exported: true,
    onDelete: "delete",
    why: "Part of the Clerk user; goes with it. privateMetadata and unsafeMetadata are not written by the app.",
    erasedBy: "clerk",
  },

  /* ------------------------------- meetings -------------------------------- */
  {
    id: "kv.event.owned",
    store: "kv",
    pattern: "neo:event:<id> where ownerUserId = <uid> (+ neo:slug:<slug>, neo:events:all entry)",
    holds: "Meetings the person owns: settings, schedule, transcript artifacts, AI summary, roles, waiting room, ticket buyers",
    personal: "Owner id/name/email; other people's ids, names and emails in roles[], waitingRoom[], recentRedemptions[]",
    exported: "summary",
    onDelete: "delete",
    why: "The person's own meetings. Exported as meeting details only: the other people in roles, waiting room and ticket lists are not theirs to receive.",
    erasedBy: "ownedEvents",
  },
  {
    id: "kv.event.subkeys",
    store: "kv",
    pattern: "Per owned meeting: neo:meeting:<id>:roles, neo:chat:<id>, neo:attendance:<id>:events, neo:event:<id>:calls, neo:event:<id>:invited, neo:report:<id>, neo:meeting:<id>:hidden-videos, neo:timer:<id>, neo:breakouts:<slug>, neo:invites:<id> + neo:invite:<token>, neo:event:<id>:jobs",
    holds: "Everything hanging off a meeting the person owns",
    personal: "Attendees' ids, names, emails; chat",
    exported: false,
    onDelete: "delete",
    why: "Goes with the meeting. Today's meeting delete leaves most of these behind; account deletion removes them all.",
    erasedBy: "ownedEvents",
  },
  {
    id: "kv.event.ownerIndex",
    store: "kv",
    pattern: "neo:owner:<uid>, neo:personal-room:<uid>",
    holds: "Which meetings are theirs; their personal room",
    personal: "User id (key)",
    exported: false,
    onDelete: "delete",
    why: "Indexes keyed by the person.",
    erasedBy: "ownedEvents",
  },
  {
    id: "kv.event.others",
    store: "kv",
    pattern: "neo:event:<id> owned by someone else: roles[].identifier, waitingRoom[], recentRedemptions[]",
    holds: "The person as a role holder, waiting-room entry or ticket buyer in someone else's meeting",
    personal: "User id, email, name",
    exported: false,
    onDelete: "anonymise",
    why: "The meeting is the other owner's; only the person's entries are removed from it.",
    erasedBy: "othersEvents",
  },
  {
    id: "kv.meetingRoles",
    store: "kv",
    pattern: "neo:meeting:<id>:roles field <uid> | <email> | kc:<handle>",
    holds: "The person's role in someone else's meeting",
    personal: "User id, email or KingsChat handle (field name)",
    exported: false,
    onDelete: "delete",
    why: "A role for a person who no longer exists.",
    erasedBy: "fieldsInOthers",
  },
  {
    id: "kv.recurringRoles",
    store: "kv",
    pattern: "neo:owner:<uid>:recurring (own) and fields <uid>|<email>|kc:<handle> in other owners' lists",
    holds: "People the owner always gives a role to",
    personal: "Identifiers of other people (own list); the person's identifiers (others' lists)",
    exported: "summary",
    onDelete: "delete",
    why: "Own list is removed; the person is removed from others' lists. Exported as a count — the entries identify other people.",
    erasedBy: "fieldsInOthers",
  },
  {
    id: "kv.chat",
    store: "kv",
    pattern: "neo:chat:<eventId> (JSON array): messages with userId = <uid>, or toUserId = <uid>",
    holds: "Meeting chat the person wrote or received as a direct message",
    personal: "User id, display name, message text",
    exported: true,
    onDelete: "anonymise",
    why: "In others' meetings the conversation stays; the author becomes \"Deleted user\" and the id is removed. (In their own meetings the whole chat is deleted with the meeting.)",
    erasedBy: "meetingChat",
  },
  {
    id: "kv.attendance",
    store: "kv",
    pattern: "neo:attendance:<eventId>:events (list) entries with userId = <uid> or the person's email",
    holds: "When the person joined and left meetings",
    personal: "User id, name, email",
    exported: true,
    onDelete: "anonymise",
    why: "The host's attendance totals stay right; who it was does not.",
    ttl: "90 days after the meeting's last attendance event",
    erasedBy: "attendance",
  },
  {
    id: "kv.reports",
    store: "kv",
    pattern: "neo:report:<eventId> participants[] / hosts[] matching the person",
    holds: "Group meeting reports",
    personal: "User id, name, email, join/leave times",
    exported: false,
    onDelete: "anonymise",
    why: "Reports are the group's record; the person's row is anonymised. Their own attendance is exported from the attendance journal instead.",
    ttl: "400 days",
    erasedBy: "reports",
  },
  {
    id: "kv.callsInvited",
    store: "kv",
    pattern: "neo:event:<id>:calls field <uid>; neo:event:<id>:invited field <uid>|<email>; neo:meeting:<id>:hidden-videos field <uid>; neo:breakouts:<slug> assignments[<uid>]",
    holds: "Ringing state, invitations, hidden videos and breakout assignments in others' meetings",
    personal: "User id or email (field name), name and email in invitations",
    exported: false,
    onDelete: "delete",
    why: "Operational state about the person in others' meetings.",
    erasedBy: "fieldsInOthers",
  },
  {
    id: "kv.userMeetings",
    store: "kv",
    pattern: "neo:user:<uid>:meetings (zset)",
    holds: "Meetings the person was invited to or attended",
    personal: "User id (key)",
    exported: true,
    onDelete: "delete",
    why: "Index keyed by the person.",
    erasedBy: "personalKeys",
  },
  {
    id: "kv.shortLived",
    store: "kv",
    pattern: "neo:presence:<uid>, neo:knock:<eventId>:<uid>, neo:group:<gid>:rate:<uid>, apiplan:<uid>, ratelimit:*, neo:video:joinrl:<ip>, neo:videochat:rl:<room>:<ip>, billing:pending:<nonce>, neo:rec-egress:<egressId>",
    holds: "Presence, rate limits, checkout handshakes",
    personal: "User id or IP (key), user id in the checkout record",
    exported: false,
    onDelete: "expire",
    why: "Expire on their own; presence is removed straight away anyway.",
    ttl: "30 seconds to 3 days",
    erasedBy: "personalKeys",
  },

  /* -------------------------------- groups --------------------------------- */
  {
    id: "kv.groups.membership",
    store: "kv",
    pattern: "neo:group:<gid>:members field <uid>; neo:user:<uid>:groups",
    holds: "Which groups the person is in, their role, name and email as the group sees them",
    personal: "User id, name, email",
    exported: true,
    onDelete: "delete",
    why: "Removed from every group (as phase 2's purge did).",
    erasedBy: "groups",
  },
  {
    id: "kv.groups.owned",
    store: "kv",
    pattern: "neo:group:<gid> (+ :members, :activity, :msgs, :ver, :read, :pending, :meetings) for groups the person owns",
    holds: "Groups the person created and still owns",
    personal: "Members' names and emails, chat",
    exported: "summary",
    onDelete: "delete",
    why: "A group with nobody else in it is deleted with the account. A group with other members must be handed to one of them first — completion refuses until then, so nobody loses a group without an administrator deciding who keeps it.",
    erasedBy: "groups",
  },
  {
    id: "kv.groups.messages",
    store: "kv",
    pattern: "neo:group:<gid>:msgs (list) entries with userId = <uid>",
    holds: "Group chat the person wrote",
    personal: "User id, name, text",
    exported: true,
    onDelete: "anonymise",
    why: "The group's conversation stays readable for the others; the author becomes \"Deleted user\".",
    erasedBy: "groupChat",
  },
  {
    id: "kv.groups.activity",
    store: "kv",
    pattern: "neo:group:<gid>:activity actorId = <uid>, details naming the person; neo:group:<gid>:read field <uid>",
    holds: "Group history lines and read markers",
    personal: "User id, name or email inside the text",
    exported: false,
    onDelete: "anonymise",
    why: "History stays for the group; the person's id and name are replaced.",
    erasedBy: "groupChat",
  },
  {
    id: "kv.groups.pending",
    store: "kv",
    pattern: "neo:group:<gid>:pending field email:<addr> | kc:<handle>; neo:pending-member:email:<addr>, neo:pending-member:kc:<handle>",
    holds: "Groups waiting for the person to sign up",
    personal: "Email address or KingsChat handle (in the key)",
    exported: false,
    onDelete: "delete",
    why: "Nobody should be added to a group under an address that was deleted.",
    erasedBy: "groups",
  },
  {
    id: "kv.groups.series",
    store: "kv",
    pattern: "neo:series:<sid> createdBy = <uid>; neo:invite:<token> createdBy = <uid> in others' meetings",
    holds: "Who set up a recurring group meeting or an invite link",
    personal: "User id only",
    exported: false,
    onDelete: "keep",
    why: "The series and links belong to the group/meeting and keep working; after deletion the id points to no one.",
    unsure: "Kept as a bare pseudonymous id. Could be blanked if the owner prefers.",
  },

  /* ------------------------- notifications, devices ------------------------ */
  {
    id: "kv.notifications",
    store: "kv",
    pattern: "neo:notif:<uid>, neo:notif:<uid>:unread",
    holds: "In-app notifications (the bell)",
    personal: "User id (key); caller names and meeting titles in the text",
    exported: true,
    onDelete: "delete",
    why: "The person's own inbox.",
    erasedBy: "personalKeys",
  },
  {
    id: "kv.push",
    store: "kv",
    pattern: "neo:push:<uid> (web push subscriptions), neo:fcm:<uid> (Android FCM tokens)",
    holds: "Devices that receive call alerts",
    personal: "Browser user agent, push endpoint and keys, FCM token",
    exported: "summary",
    onDelete: "delete",
    why: "Exported as device type and dates; endpoints, keys and tokens are credentials and never leave the server.",
    erasedBy: "personalKeys",
  },
  {
    id: "kv.kingschat",
    store: "kv",
    pattern: "neo:kc:tokens:<uid>; neo:kc:handle-to-clerk:<handle> = <uid>",
    holds: "KingsChat sign-in tokens and handle lookup",
    personal: "OAuth access/refresh tokens; KingsChat handle (key)",
    exported: false,
    onDelete: "delete",
    why: "Credentials — never exported. The KingsChat username itself is in the exported profile.",
    erasedBy: "personalKeys",
  },
  {
    id: "kv.sessions",
    store: "kv",
    pattern: "neo:session:<hash>, neo:sessions:<uid>, neo:session-device:<uid>:<fingerprint>",
    holds: "Signed-in devices",
    personal: "IP address, user agent, device fingerprint",
    exported: true,
    onDelete: "delete",
    why: "Signed out everywhere and the records removed.",
    ttl: "90 days sliding, 1 year cap",
    erasedBy: "personalKeys",
  },

  /* ---------------------------- billing and API ---------------------------- */
  {
    id: "kv.payments",
    store: "kv",
    pattern: "billing:payment:<paymentRef> where userId = <uid>",
    holds: "Payments and invoice numbers",
    personal: "User id",
    exported: true,
    onDelete: "anonymise",
    why: "Kept for legal (tax and accounting) retention, detached from the person: the user id is replaced by a pseudonym that no longer resolves to anyone. Amounts, plan, dates and invoice numbers stay.",
    erasedBy: "payments",
  },
  {
    id: "kv.paymentsIndex",
    store: "kv",
    pattern: "billing:payments:<uid>",
    holds: "The person's list of payment refs",
    personal: "User id (key)",
    exported: false,
    onDelete: "delete",
    why: "The index is what ties the kept payments to a person.",
    erasedBy: "payments",
  },
  {
    id: "kv.apiKeys",
    store: "kv",
    pattern: "apikeys:user:<uid>, apikey:meta:<id>, apikey:hash:<id>, apikey:<sha256>",
    holds: "Developer API keys",
    personal: "Owner id; key name",
    exported: "summary",
    onDelete: "delete",
    why: "Exported as name, plan, dates and status. The key hash and the masked key are never exported (secrets).",
    erasedBy: "apiKeys",
  },
  {
    id: "kv.apiMeetings",
    store: "kv",
    pattern: "meeting:<id>, meetings:user:<uid>",
    holds: "Meetings created through the public API",
    personal: "Owner id, meeting names and metadata",
    exported: true,
    onDelete: "delete",
    why: "The person's own data.",
    erasedBy: "apiKeys",
  },

  /* ------------------------ recordings and transcripts ---------------------- */
  {
    id: "r2.recordings",
    store: "r2",
    pattern: "recordings/<sanitized uid>/<room>/<timestamp>.mp4 / .m4a",
    holds: "Recordings the person started",
    personal: "Video and audio (of everyone in the meeting); user id in the path",
    exported: "summary",
    onDelete: "delete",
    why: "Exported as a list (name, size, date, where to download them in the app) — the files can be large and show other people. Deleted with the account.",
    erasedBy: "r2",
  },
  {
    id: "r2.chatUploads",
    store: "r2",
    pattern: "chat/<uid>/<uuid>-<name>",
    holds: "Files the person shared in meeting chat",
    personal: "File contents; user id in the path",
    exported: "summary",
    onDelete: "delete",
    why: "The person's uploads.",
    erasedBy: "r2",
  },
  {
    id: "r2.groupUploads",
    store: "r2",
    pattern: "groups/<gid>/<uuid>-<name>",
    holds: "Files shared in group chat",
    personal: "File contents; uploader only via the message",
    exported: false,
    onDelete: "keep",
    why: "Deleted with a group the person owned alone. In others' groups the file stays with the (anonymised) message as part of the group's conversation.",
    erasedBy: "groups",
    unsure: "Kept in others' groups. Deleting the person's own attachments there is possible (the message holds the key) if preferred.",
  },
  {
    id: "kv.transcripts",
    store: "kv",
    pattern: "neo:transcribe:<jobId> + neo:transcribe:key:<b64(recordingKey)> for recordings under the person's prefix",
    holds: "Transcripts and summaries of the person's recordings",
    personal: "Words spoken by everyone in the meeting, speaker labels",
    exported: "summary",
    onDelete: "delete",
    why: "Exported as a list with links (job, date, status); the text contains other people's words. Deleted with the recordings.",
    ttl: "30 days",
    erasedBy: "recordingMeta",
  },
  {
    id: "kv.recordingMeta",
    store: "kv",
    pattern: "neo:rec:<views|downloads|shares>:<b64(key)>, neo:share:<token> (ownerUserId), neo:rec-usage:<uid>",
    holds: "Recording counters, share links, recording minutes per month",
    personal: "User id",
    exported: "summary",
    onDelete: "delete",
    why: "Go with the recordings.",
    erasedBy: "recordingMeta",
  },

  /* --------------------------------- admin --------------------------------- */
  {
    id: "kv.admin.userRecords",
    store: "kv",
    pattern: "neo:admin:user-tags field <uid>, neo:admin:user:<uid>:notes, neo:admin:suspensions field <uid>, neo:admin:deletions field <uid>, neo:admin:user:<uid>:support",
    holds: "What administrators noted about the account",
    personal: "Notes, tags, suspension reason, support sessions (with administrators' emails)",
    exported: "summary",
    onDelete: "delete",
    why: "Exported: suspension, deletion request and support sessions (dates and reasons, without administrators' details). Internal notes and tags are not exported.",
    erasedBy: "admin",
    unsure: "Internal notes are excluded from the export. Under a strict reading of the right of access they may need to be included.",
  },
  {
    id: "kv.admin.member",
    store: "kv",
    pattern: "neo:admin:members field <uid>; neo:admin:mfa:<uid>",
    holds: "Administrator appointment and two-factor secret, if the person was an administrator",
    personal: "Name, email, encrypted TOTP secret",
    exported: false,
    onDelete: "anonymise",
    why: "The record stays as \"removed\" (so the role history reads right) with name and email blanked; the two-factor secret is deleted.",
    erasedBy: "admin",
  },
  {
    id: "kv.admin.audit",
    store: "kv",
    pattern: "neo:admin:audit:<YYYY-MM> entries naming the person",
    holds: "What administrators did to the account",
    personal: "User id and email as the target label; values before/after",
    exported: false,
    onDelete: "keep",
    why: "Security and accountability record of administrators' actions, append-only; governed by the audit retention setting (forever by default, at least a year). The deletion certificate added to it holds no personal data.",
    unsure: "Older entries keep the email as target label. Rewriting the append-only log was deliberately not done.",
  },
  {
    id: "kv.authzLog",
    store: "kv",
    pattern: "neo:authz:log entries with userId = <uid>",
    holds: "Permission decisions in meetings and groups",
    personal: "User id",
    exported: false,
    onDelete: "keep",
    why: "Security log, capped at 5000 entries; the person's entries roll off. Pseudonymous once the account is gone.",
  },
  {
    id: "kv.data.governance",
    store: "kv",
    pattern: "neo:data:requests:log, neo:data:erased, neo:data:holds field <uid>, neo:data:export:<id>, neo:data:exports:<uid>",
    holds: "Deletion requests, the erased tombstone, legal holds, exports",
    personal: "User id only (requests log, tombstone)",
    exported: "summary",
    onDelete: "keep",
    why: "Proof that a deletion was asked for and done, and the tombstone that stops a backup restore from bringing the person back. Export records are deleted.",
    erasedBy: "exports",
  },
  {
    id: "r2.exports",
    store: "r2",
    pattern: "data-exports/<uid>/<exportId>.zip",
    holds: "Data exports",
    personal: "Everything in the export",
    exported: false,
    onDelete: "delete",
    why: "Deleted with the account, and after 7 days anyway.",
    ttl: "7 days",
    erasedBy: "exports",
  },
  {
    id: "trash",
    store: "kv",
    pattern: "neo:trash:items field <id> (ownerId = <uid>), neo:trash:snap:<id>; R2 trash/<original key>",
    holds: "The person's deleted meetings, groups and recordings, restorable for the trash period",
    personal: "As the originals",
    exported: false,
    onDelete: "delete",
    why: "Deleting the account empties its trash too.",
    erasedBy: "trash",
  },

  /* ---------------------------- not linked to accounts ------------------------ */
  {
    id: "kv.videoRooms",
    store: "kv",
    pattern: "neo:video:codes:<room>, neo:video:rosterfile:<room>, neo:video:rosterbatch:*, neo:videochat:<room>, neo:video:featured:<room>",
    holds: "Control-room rosters (names, contact and other columns from an uploaded spreadsheet) and room chat",
    personal: "Participants' names, contact details, free-form columns",
    exported: false,
    onDelete: "keep",
    why: "Not linked to a NeoConference account: these are people on a roster, identified by name only. The room's operator removes them (wipe room).",
    unsure: "Rosters may hold phone numbers or health data with no retention period. Worth a retention rule of their own.",
  },

  /* ------------------- stores added by the other admin phases ------------------- */
  {
    id: "kv.activity",
    store: "kv",
    pattern: "neo:act:u:<uid>; neo:act:log:<day> entries with userId/account = <uid>; neo:act:users, neo:act:dau:<day>, neo:act:new:<day> members; neo:act:acct:<day> fields <uid>|<metric>",
    holds: "Activity events (analytics) and daily counts",
    personal: "User id, event properties",
    exported: true,
    onDelete: "anonymise",
    why: "The person's own stream and their raw events are deleted (src/lib/activity.ts forgetUserActivity); in the daily counts the id becomes the pseudonym, so totals stay right. Raw events also go with the activity retention (ACTIVITY_RETENTION_DAYS, and the purge here); daily counts after 400 days.",
    ttl: "Raw events: activity retention (90 days); counts: 400 days",
    erasedBy: "activity",
  },
  {
    id: "kv.supportTickets",
    store: "kv",
    pattern: "neo:support:tickets (userId/email/name), neo:support:msgs:<id> (authorName, attachments), R2 ticket attachments",
    holds: "Support tickets the person raised",
    personal: "Name, email, messages, attachments",
    exported: true,
    onDelete: "anonymise",
    why: "Ticket text, support's replies and internal notes stay so the support history reads; requester id, email and name are removed and their attachments deleted (src/lib/support/tickets.ts anonymiseTicketsForAccount). Exported without internal notes or agents' names.",
    erasedBy: "tickets",
  },
  {
    id: "kv.comms",
    store: "kv",
    pattern: "neo:comms:prefs:<uid>, neo:comms:rem:<uid>:*, neo:comms:bounced:<email>; entries in neo:comms:log / neo:comms:events and every send's recipient blocks, statuses and failures",
    holds: "Notification preferences, reminder flags, email delivery records",
    personal: "User id, email address, name",
    exported: "summary",
    onDelete: "delete",
    why: "Preferences and flags deleted; delivery records anonymised so counts stay right (src/lib/comms/forget.ts forgetCommsUser). Exported: the preferences. Resend refs (neo:comms:msg:<id>) name the id and expire after 35 days.",
    erasedBy: "comms",
  },
  {
    id: "kv.subscriptions",
    store: "kv",
    pattern: "neo:sub:<uid>, neo:sub:h:<uid>, neo:subs:users / by_end / ended, neo:coupon:u:<code>",
    holds: "Subscription and its history",
    personal: "User id, email",
    exported: true,
    onDelete: "anonymise",
    why: "The live record and indexes are removed; the history is a billing record, kept detached under an anonymous key (src/lib/billing/subscriptions.ts forgetSubscriptionUser). Exported with who changed it as \"you\" or \"an administrator\".",
    erasedBy: "subscriptions",
  },
  {
    id: "kv.finance",
    store: "kv",
    pattern: "billing:ticket:<sessionId> (email, name), billing:invoice:<id> (buyer name, email), billing:reminders:log (email)",
    holds: "Ticket purchases, invoices, payment reminders",
    personal: "Name, email",
    exported: true,
    onDelete: "anonymise",
    why: "Kept for legal retention: amounts, numbers, dates and tax stay; names and emails are blanked (src/lib/finance/governance.ts anonymiseFinanceForUser), including guest purchases under any of the person's addresses.",
    unsure: "Ticket records keep the Clerk user id (it resolves to no one once the account is gone); plan payments use a pseudonym instead.",
    erasedBy: "finance",
  },
  {
    id: "r2.backups",
    store: "r2",
    pattern: "ops-backups/kv/<id>.json.gz",
    holds: "KV snapshots",
    personal: "Everything in KV at the time",
    exported: false,
    onDelete: "expire",
    why: "Backups are not edited; they age out under the backups retention setting (the purge here, through deleteBackup) and the operations phase's own count limit. A restore leaves alone every key that names or holds an id in the erased tombstone (neo:data:erased), and never writes over neo:data:*, so a deleted account does not come back (src/lib/ops/backup.ts).",
    ttl: "Backups retention (default 14 days)",
  },
];

/** The locations an account deletion must handle in code (delete or anonymise, on main). */
export function erasableLocations(): DataLocation[] {
  return DATA_MAP.filter((d) => !d.pending && (d.onDelete === "delete" || d.onDelete === "anonymise"));
}
