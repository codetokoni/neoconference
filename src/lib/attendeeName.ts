// src/lib/attendeeName.ts
//
// A meeting attendee's full name, by one set of rules for sign-in, the
// meeting room, the attendance report on screen and every attendance export.
//
// Administrators saw only usernames and email addresses for people who came
// with KingsChat: KingsChat's profile gives one `name` (not first and last),
// sign-in looked only for first and last names, so the account had none and
// everything fell back to the handle.
//
// The rules:
//   1. the full name KingsChat gave at the person's latest sign-in
//      (publicMetadata.kingschat.name);
//   2. otherwise the name saved on the account (Clerk first + last name),
//      which is where a name the person types in is kept;
//   3. otherwise none: the report says "Name unavailable" and an export
//      leaves the cell blank.
// Blank or whitespace-only values count as missing.
//
// Pure: no Clerk, no network. Safe in the browser and on the server.

export const NAME_UNAVAILABLE = "Name unavailable";

/** Longest full name kept (Clerk's own name fields take far more). */
export const FULL_NAME_MAX = 100;

/** A name with its whitespace tidied; "" for anything blank or not text. */
export function cleanFullName(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/\s+/g, " ").trim().slice(0, FULL_NAME_MAX).trim();
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function field(o: Obj, keys: string[]): string {
  const lower = new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) {
    const v = cleanFullName(lower.get(k));
    if (v) return v;
  }
  return "";
}

const FULL = ["name", "full_name", "fullname", "display_name", "displayname"];
const GIVEN = ["first_name", "firstname", "given_name", "givenname"];
const FAMILY = ["last_name", "lastname", "family_name", "familyname", "surname"];

/**
 * The full name in a KingsChat profile. KingsChat answers
 * `{ profile: { user: { user_id, username, name, … }, email: {…} } }`; older
 * and other shapes put the person at the top or under `user`. A full name
 * wins; otherwise given and family names, whichever are there, are joined.
 * Only the person's own object is read, so the name of something nested
 * elsewhere (an email object, a church) is never taken for theirs.
 */
export function kcProfileName(profile: unknown): string {
  if (!isObj(profile)) return "";
  const inner = isObj(profile.profile) ? profile.profile : null;
  const candidates: Obj[] = [];
  if (inner && isObj(inner.user)) candidates.push(inner.user);
  if (isObj(profile.user)) candidates.push(profile.user);
  if (inner) candidates.push(inner);
  candidates.push(profile);
  for (const c of candidates) {
    const full = field(c, FULL);
    if (full) return full;
    const joined = cleanFullName([field(c, GIVEN), field(c, FAMILY)].join(" "));
    if (joined) return joined;
  }
  return "";
}

/** A full name as Clerk's first and last name: the last word is the last name. */
export function splitFullName(full: string): { firstName: string; lastName: string } {
  const name = cleanFullName(full);
  const at = name.lastIndexOf(" ");
  if (at <= 0) return { firstName: name, lastName: "" };
  return { firstName: name.slice(0, at), lastName: name.slice(at + 1) };
}

/** The parts of an account the rules read (a Clerk user, server or browser). */
export interface NamedAccount {
  firstName?: string | null;
  lastName?: string | null;
  publicMetadata?: unknown;
}

function kingschatOf(u: NamedAccount): Obj | null {
  const md = u.publicMetadata;
  return isObj(md) && isObj(md.kingschat) ? md.kingschat : null;
}

/** Whether the account signs in with KingsChat. */
export function isKcAccount(u: NamedAccount | null | undefined): boolean {
  const kc = u ? kingschatOf(u) : null;
  return Boolean(kc && (typeof kc.id === "string" || typeof kc.id === "number") && String(kc.id).trim());
}

/** The name saved on the account: first and last name. */
export function localFullName(u: NamedAccount): string {
  return cleanFullName([u.firstName ?? "", u.lastName ?? ""].join(" "));
}

/** The attendee's full name by the rules above; "" when there is none. */
export function accountFullName(u: NamedAccount | null | undefined): string {
  if (!u) return "";
  const kc = kingschatOf(u);
  return cleanFullName(kc?.name) || localFullName(u);
}

/**
 * Whether to ask for a full name before joining: a KingsChat account with no
 * name from KingsChat and none saved. Asked once: the answer is saved on the
 * account and found by accountFullName from then on. Other accounts are never
 * asked; their sign-up is unchanged.
 */
export function needsFullName(u: NamedAccount | null | undefined): boolean {
  return isKcAccount(u) && !accountFullName(u);
}

/** Why a typed full name cannot be saved, or "" when it can. */
export function fullNameProblem(v: unknown): string {
  const name = cleanFullName(v);
  if (!name) return "Enter your full name.";
  if (typeof v === "string" && v.replace(/\s+/g, " ").trim().length > FULL_NAME_MAX) {
    return `Keep it under ${FULL_NAME_MAX} characters.`;
  }
  if (!/\p{L}/u.test(name)) return "Enter your name in letters.";
  if (name.length < 2) return "Enter your full name.";
  return "";
}

/** A full name as the on-screen report shows it. */
export function reportName(fullName: string | null | undefined): string {
  return cleanFullName(fullName) || NAME_UNAVAILABLE;
}

/** Search across an attendee's full name, username and email (case and spacing ignored). */
export function matchesAttendee(
  p: { fullName?: string | null; username?: string | null; email?: string | null; name?: string | null },
  query: string,
): boolean {
  const q = cleanFullName(query).toLowerCase();
  if (!q) return true;
  return [p.fullName, p.username, p.email, p.name].some((v) => cleanFullName(v).toLowerCase().includes(q));
}
