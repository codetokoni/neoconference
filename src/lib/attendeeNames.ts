// src/lib/attendeeNames.ts
//
// Full names for attendance records, looked up from the accounts they belong
// to (src/lib/attendeeName.ts has the rules).
//
// Every record a meeting room writes carries the attendee's account id (the
// LiveKit identity the token route stamps, or the signed-in caller for a
// beacon), so a record is linked to its person by that id, never by a
// username or an email. Names are looked up when a report is read or
// exported, not stored in it: a cached report outlives the attendance
// records it was built from (90 days), and a name someone adds later still
// reaches the reports of meetings they were already in.
//
// Records with no account id (a partner page's visitor, who typed a name to
// come in) keep the name they came with. A record whose account no longer
// exists, or has no name, has none: "Name unavailable" on screen, a blank
// cell in an export.

import { accountFullName, cleanFullName } from "@/lib/attendeeName";
import { CLERK_USER_ID } from "@/lib/groupAttendees";
import type { AttendanceReportRow } from "@/lib/attendance";

export interface AccountName {
  /** "" when the account has no name. */
  fullName: string;
  /** The account's username (a KingsChat handle for KingsChat accounts), or "". */
  username: string;
}

/** Clerk returns at most this many accounts per lookup. */
const BATCH = 100;
/** Names are reused this long in one server instance (a range export reads many meetings). */
const CACHE_MS = 60_000;

type Lookup = (userIds: string[]) => Promise<Map<string, AccountName>>;

async function clerkLookup(userIds: string[]): Promise<Map<string, AccountName>> {
  const { clerkClient } = await import("@clerk/nextjs/server");
  const cc = await clerkClient();
  const out = new Map<string, AccountName>();
  for (let i = 0; i < userIds.length; i += BATCH) {
    const ids = userIds.slice(i, i + BATCH);
    const list = await cc.users.getUserList({ userId: ids, limit: BATCH });
    for (const u of list.data) {
      out.set(u.id, { fullName: accountFullName(u), username: cleanFullName(u.username) });
    }
  }
  return out;
}

let lookup: Lookup = clerkLookup;
const cache = new Map<string, { at: number; v: AccountName | null }>();

/** Tests only: replace the account lookup (null restores Clerk), and forget cached names. */
export function __setNameLookup(fake: Lookup | null): void {
  lookup = fake ?? clerkLookup;
  cache.clear();
}

/**
 * Names for account ids. Only real account ids are looked up; an id with no
 * account is absent from the result. Never throws: if the lookup fails, the
 * ids it could not reach are absent too, and the report says so rather than
 * failing to open.
 */
export async function accountNames(ids: Iterable<string>, now: number = Date.now()): Promise<Map<string, AccountName>> {
  const wanted = Array.from(new Set(Array.from(ids).filter((id) => CLERK_USER_ID.test(id))));
  const out = new Map<string, AccountName>();
  const missing: string[] = [];
  for (const id of wanted) {
    const hit = cache.get(id);
    if (hit && now - hit.at < CACHE_MS) {
      if (hit.v) out.set(id, hit.v);
    } else {
      missing.push(id);
    }
  }
  if (missing.length) {
    try {
      const found = await lookup(missing);
      for (const id of missing) {
        const v = found.get(id) ?? null;
        cache.set(id, { at: now, v });
        if (v) out.set(id, v);
      }
    } catch (err) {
      console.warn("[attendeeNames] could not look up names", err);
    }
  }
  return out;
}

/**
 * The full name for one attendance record: its account's, when it has an
 * account id; the name it came with, when it has none; "" otherwise.
 */
export function recordFullName(
  accountId: string | null | undefined,
  cameWith: string | null | undefined,
  names: Map<string, AccountName>,
): string {
  if (accountId && CLERK_USER_ID.test(accountId)) return names.get(accountId)?.fullName ?? "";
  return cleanFullName(cameWith);
}

/** A meeting's attendance rows with each Full Name resolved by the rules. */
export async function withFullNames(rows: AttendanceReportRow[]): Promise<AttendanceReportRow[]> {
  const names = await accountNames(rows.map((r) => r.username));
  return rows.map((r) => ({ ...r, fullName: recordFullName(r.username, r.fullName, names) }));
}
