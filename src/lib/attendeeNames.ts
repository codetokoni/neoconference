// src/lib/attendeeNames.ts
//
// Usernames for attendance records, looked up from the accounts they belong
// to. Every record a meeting room writes carries the attendee's account id
// (the LiveKit identity the token route stamps, or the signed-in caller for
// a beacon), so a record is linked to its person by that id.
//
// Full names are not looked up. The "Full name for attendance" is captured
// when someone joins and recorded on that join's entry
// (src/lib/attendanceName.ts), so a meeting keeps the name it was attended
// under even if the person changes it later. A record from before names were
// captured says "Name not captured".
//
// The username is the account's (a KingsChat handle for KingsChat accounts),
// looked up when a report is read or exported; a record whose account no
// longer exists keeps its account id.

import { cleanFullName } from "@/lib/attendeeName";
import { CLERK_USER_ID } from "@/lib/groupAttendees";
import type { AttendanceReportRow } from "@/lib/attendance";

export interface AccountName {
  /** The account's username (a KingsChat handle for KingsChat accounts), or "". */
  username: string;
  /** The account's primary email address, or "" (absent when a lookup did not say). */
  email?: string;
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
      const kc = (u.publicMetadata as { kingschat?: { username?: unknown } } | undefined)?.kingschat;
      out.set(u.id, {
        username: cleanFullName(kc?.username) || cleanFullName(u.username),
        email: (u.primaryEmailAddress?.emailAddress || u.emailAddresses?.[0]?.emailAddress || "").toLowerCase(),
      });
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
 * Usernames for account ids. Only real account ids are looked up; an id with
 * no account is absent from the result. Never throws: if the lookup fails,
 * the ids it could not reach are absent too, and the report says so rather
 * than failing to open.
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
 * A meeting's attendance rows with each Username the account's (its id when
 * there is none), and an Email the records lacked (a join only LiveKit
 * reported carries none) filled in from the account.
 */
export async function withUsernames(rows: AttendanceReportRow[]): Promise<AttendanceReportRow[]> {
  const names = await accountNames(rows.map((r) => r.username));
  return rows.map((r) => {
    const a = names.get(r.username);
    return { ...r, username: a?.username || r.username, email: r.email || a?.email || "" };
  });
}
