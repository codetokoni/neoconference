// src/lib/attendanceName.ts
//
// The "Full name for attendance" a person confirms before joining a meeting
// (the rules are in src/lib/attendeeName.ts). Two copies, each with one job:
//
//   Clerk privateMetadata.attendanceName   their account's: what the next
//                                          meeting's join screen offers
//   neo:attname:<userId>  (KV, 3 days)     { name, at }: their latest
//                                          confirmation, for the join
//
// The join is where it is written into attendance. The LiveKit webhook and
// the room's beacon record each join; both read the latest confirmation here
// (one KV read) and put the name on that join's entry, keyed by the person's
// account id. So every later reconnect of the same person is the same
// attendee, two people with the same name stay two attendees, and a name
// changed afterwards never rewrites a meeting that already happened.
//
// The token route asks for a confirmation within CONFIRM_WINDOW_MS before it
// lets anyone in, which is the server's half of "required before joining".

import { kv } from "@/lib/kv";
import { attendanceNameProblem, cleanFullName, savedAttendanceName, type AttendanceAccount } from "@/lib/attendeeName";

const KEY = (userId: string) => `neo:attname:${userId}`;
const TTL_S = 3 * 24 * 60 * 60;

/** How recent a confirmation must be for the token route to let someone in. */
export const CONFIRM_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface Confirmation {
  name: string;
  /** Epoch ms. */
  at: number;
}

function kvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// Without KV (local development, some tests) confirmations live in memory.
const mem = new Map<string, Confirmation>();

/** The account id a LiveKit identity belongs to ("user_x#nonce" → "user_x"). */
export function accountIdOf(identity: string | null | undefined): string {
  return (identity ?? "").split("#")[0];
}

/** The latest confirmation, or null. Never throws: a join is recorded without a name rather than not at all. */
export async function latestConfirmation(userId: string): Promise<Confirmation | null> {
  const id = accountIdOf(userId);
  if (!id) return null;
  try {
    const raw = kvConfigured() ? await kv.get(KEY(id)) : mem.get(id) ?? null;
    const v = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<Confirmation> | null;
    const name = cleanFullName(v?.name);
    return name && typeof v?.at === "number" ? { name, at: v.at } : null;
  } catch (err) {
    console.warn("[attendanceName] could not read the confirmation", err);
    return null;
  }
}

/** The name to put on a join's attendance entry: the latest confirmation's, or "". */
export async function nameForJoin(identity: string | null | undefined): Promise<string> {
  return (await latestConfirmation(accountIdOf(identity)))?.name ?? "";
}

/** Whether someone confirmed recently enough to be let into a meeting. */
export async function hasFreshConfirmation(userId: string, now: number = Date.now()): Promise<boolean> {
  const c = await latestConfirmation(userId);
  return Boolean(c && now - c.at < CONFIRM_WINDOW_MS);
}

type SaveOnAccount = (userId: string, name: string) => Promise<void>;

async function clerkSave(userId: string, name: string): Promise<void> {
  const { clerkClient } = await import("@clerk/nextjs/server");
  const cc = await clerkClient();
  await cc.users.updateUserMetadata(userId, { privateMetadata: { attendanceName: name } });
}

let saveOnAccount: SaveOnAccount = clerkSave;

/** Tests only: replace the account write (null restores Clerk). */
export function __setAccountSave(fake: SaveOnAccount | null): void {
  saveOnAccount = fake ?? clerkSave;
}

export type ConfirmResult = { ok: true; name: string } | { ok: false; status: number; message: string };

/**
 * Someone confirmed their attendance name on the join screen. Checked here
 * whatever the screen checked; saved on their account when it changed, and
 * remembered as their latest confirmation for the join that follows.
 */
export async function confirmAttendanceName(
  user: AttendanceAccount & { id: string },
  typed: unknown,
  now: number = Date.now(),
): Promise<ConfirmResult> {
  const problem = attendanceNameProblem(typed);
  if (problem) return { ok: false, status: 400, message: problem };
  const name = cleanFullName(typed);
  if (savedAttendanceName(user) !== name) {
    try {
      await saveOnAccount(user.id, name);
    } catch (err) {
      console.error("[attendanceName] could not save the name on the account", err);
      return { ok: false, status: 502, message: "Your name could not be saved. Try again." };
    }
  }
  try {
    await rememberConfirmation(user.id, name, now);
  } catch (err) {
    console.error("[attendanceName] could not remember the confirmation", err);
    return { ok: false, status: 502, message: "Your name could not be saved. Try again." };
  }
  return { ok: true, name };
}

/** Remember a name as someone's latest confirmation (for their next join). Throws if it cannot. */
export async function rememberConfirmation(userId: string, name: string, now: number = Date.now()): Promise<void> {
  const c: Confirmation = { name: cleanFullName(name), at: now };
  if (kvConfigured()) await kv.set(KEY(userId), JSON.stringify(c), { ex: TTL_S });
  else mem.set(userId, c);
}
