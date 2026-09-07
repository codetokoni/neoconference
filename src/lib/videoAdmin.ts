import { currentUser } from "@clerk/nextjs/server";

/**
 * Access control for the video room's ADMIN surfaces — not to be confused
 * with the platform-wide `isAdmin` in lib/roles which uses ADMIN_EMAILS.
 *
 * These are the URLs an admin holds close and never shares:
 *
 *   - /video/room               the admin hub
 *   - /video/rooms              create / list rooms
 *   - POST /api/video/rooms     provision a new room
 *   - POST /api/video/room/roster upload a participant spreadsheet
 *   - GET  /api/video/room/roster download the participant xlsx
 *
 * The moderator handout (/video/room/moderate), boards, join, streaming,
 * and studio URLs are unaffected — staff role is enough for those.
 *
 * Sourced from VIDEO_ROOM_ADMIN_EMAILS env var; defaults to the two
 * addresses the owner authorised while this list is small.
 */

const DEFAULT_VIDEO_ROOM_ADMINS = [
  "victoragbasa@neoemail.org",
  "victoragbasa@gmail.org",
];

export function videoRoomAdminEmails(): string[] {
  const env = (process.env.VIDEO_ROOM_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return env.length ? env : DEFAULT_VIDEO_ROOM_ADMINS.map((e) => e.toLowerCase());
}

export function isVideoRoomAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return videoRoomAdminEmails().includes(email.toLowerCase());
}

/**
 * True iff the signed-in user's verified/primary email is in the video
 * room admin list. Server components and route handlers should redirect
 * or return 403 when this returns false.
 */
export async function isVideoRoomAdmin(): Promise<boolean> {
  const u = await currentUser();
  if (!u) return false;
  const emails = (u.emailAddresses ?? []).map((e) => e.emailAddress);
  return emails.some(isVideoRoomAdminEmail);
}
