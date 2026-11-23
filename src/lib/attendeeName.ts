// src/lib/attendeeName.ts
//
// How meetings name the people in them. Two names, kept apart:
//
//   the display name      what the meeting's tiles and people list show:
//                         a KingsChat account's username, otherwise the
//                         account's own name, username or email (displayNameFor)
//   the attendance name   "Full name for attendance", typed or confirmed by
//                         the person before every meeting they join, and only
//                         ever shown in attendance reports and exports
//
// KingsChat's profile gives one `name` (not first and last); it is the first
// suggestion for the attendance name, never its username or email.
//
// Pure: no Clerk, no network. Safe in the browser and on the server.

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

/* ------------------------- the attendance name ------------------------- */
//
// Everyone confirms a "Full name for attendance" before joining a meeting
// (the join screen on the web, the app's join step). It is saved on their
// account, private to them (privateMetadata.attendanceName), so the next
// meeting offers it again to review, and it is recorded on the attendance
// entry of each meeting they join (src/lib/attendanceName.ts) — so changing
// it later never changes who a past meeting says came.

/** What a report and an export say for someone whose attendance name was never captured. */
export const NAME_NOT_CAPTURED = "Name not captured";
export const ATTENDANCE_NAME_REQUIRED = "Enter your full name for attendance";

/** Letters (any script, with accents), spaces, apostrophes, hyphens, full stops. */
const ATTENDANCE_NAME_CHARS = /^\p{L}[\p{L}\p{M} .'’‘-]*$/u;

/** Why a typed attendance name cannot be used, or "" when it can. */
export function attendanceNameProblem(v: unknown): string {
  if (typeof v === "string" && v.replace(/\s+/g, " ").trim().length > FULL_NAME_MAX) {
    return `Keep it under ${FULL_NAME_MAX} characters.`;
  }
  const name = cleanFullName(v);
  if (!name) return ATTENDANCE_NAME_REQUIRED;
  if (name.includes("@")) return "Enter your name, not an email address.";
  if (!ATTENDANCE_NAME_CHARS.test(name)) return "Use letters only, with spaces, apostrophes or hyphens between them.";
  if (name.replace(/[^\p{L}]/gu, "").length < 2) return ATTENDANCE_NAME_REQUIRED;
  return "";
}

/** The parts of an account the attendance-name rules read. */
export interface AttendanceAccount extends NamedAccount {
  username?: string | null;
  privateMetadata?: unknown;
  emailAddresses?: { emailAddress: string }[];
  primaryEmailAddress?: { emailAddress?: string } | null;
}

/** The attendance name the person last confirmed, saved on their account; "" when none. */
export function savedAttendanceName(u: AttendanceAccount | null | undefined): string {
  const pm = u?.privateMetadata;
  return isObj(pm) ? cleanFullName(pm.attendanceName) : "";
}

function kcUsername(u: AttendanceAccount): string {
  return cleanFullName(kingschatOf(u)?.username) || cleanFullName(u.username);
}

/** Texts that are an account's handle or address, never a name to suggest. */
function handlesOf(u: AttendanceAccount): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const s = cleanFullName(v).toLowerCase();
    if (s) out.add(s);
  };
  add(u.username);
  add(kingschatOf(u)?.username);
  for (const e of [u.primaryEmailAddress?.emailAddress, ...(u.emailAddresses ?? []).map((x) => x.emailAddress)]) {
    add(e);
    add(typeof e === "string" ? e.split("@")[0] : "");
  }
  return out;
}

/**
 * What the attendance field starts with: the name they confirmed last time;
 * on first use, the full name KingsChat gave (its own `name`, never the
 * handle), else a first and last name saved on the account; otherwise blank.
 * Never a username or an email address, even when one was saved as a name.
 */
export function attendanceNamePrefill(u: AttendanceAccount | null | undefined): string {
  if (!u) return "";
  const saved = savedAttendanceName(u);
  if (saved) return saved;
  const handles = handlesOf(u);
  for (const candidate of [cleanFullName(kingschatOf(u)?.name), localFullName(u)]) {
    if (candidate && !handles.has(candidate.toLowerCase()) && !attendanceNameProblem(candidate)) return candidate;
  }
  return "";
}

/* --------------------------- the meeting name --------------------------- */
//
// The name others see in meetings can be chosen: "Display name" on the join
// screen, or "Change my name" in the meeting (/api/me/display-name). It is
// saved on the account (publicMetadata.meetingName: what everyone in a
// meeting sees anyway) and wins over the default below. Asked for in the SA
// meeting of 23 Nov 2026 by someone shown by their KingsChat handle who
// wanted their name and title instead. Attendance keeps its own full name.

export const MEETING_NAME_MAX = 60;

/** Letters and numbers (any script), with spaces and . , ' - ( ) & between. */
const MEETING_NAME_CHARS = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,'’‘()&-]*$/u;

/** Why a chosen meeting name cannot be used, or "" when it can. */
export function meetingNameProblem(v: unknown): string {
  if (typeof v === "string" && v.replace(/\s+/g, " ").trim().length > MEETING_NAME_MAX) {
    return `Keep it under ${MEETING_NAME_MAX} characters.`;
  }
  const name = cleanFullName(v);
  if (!name) return "Enter the name others should see.";
  if (name.includes("@")) return "Enter a name, not an email address.";
  if (!MEETING_NAME_CHARS.test(name)) return "Use letters and numbers, with spaces, full stops, apostrophes or hyphens.";
  if (name.replace(/[^\p{L}]/gu, "").length < 2) return "Enter at least two letters.";
  return "";
}

/** The meeting name the person chose, or "" when they never did (or it is no longer valid). */
export function chosenMeetingName(u: NamedAccount | null | undefined): string {
  const md = u?.publicMetadata;
  const v = isObj(md) ? cleanFullName(md.meetingName) : "";
  return v && !meetingNameProblem(v) ? v : "";
}

/**
 * The name the meeting's tiles and people list show: the name the person
 * chose (chosenMeetingName); otherwise a KingsChat account's KingsChat
 * username; otherwise the account's name, username or email.
 * Never the attendance name.
 */
export function displayNameFor(u: AttendanceAccount | null | undefined, fallback = ""): string {
  if (!u) return fallback;
  const chosen = chosenMeetingName(u);
  if (chosen) return chosen;
  if (isKcAccount(u)) return kcUsername(u) || fallback;
  return (
    localFullName(u) ||
    cleanFullName(u.username) ||
    cleanFullName(u.primaryEmailAddress?.emailAddress) ||
    fallback
  );
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
