import { fetchSubtracks } from "@/lib/simulcast";
import { claimedCodes, listCodes, roomMainTrack, signedOutCodes } from "@/lib/participantCodes";

/**
 * The room's participants who are live right now, as stream ids in slot
 * order. Someone signed out by a moderator is left out even if an old page
 * of theirs is still sending. When AMS cannot be reached this is empty:
 * nobody is added on a guess.
 */
export async function liveStreamsInSlotOrder(room: string): Promise<string[]> {
  let live: Set<string>;
  try {
    const subs = await fetchSubtracks(roomMainTrack(room));
    live = new Set(subs.filter((b) => b.status === "broadcasting").map((b) => b.streamId));
  } catch {
    return [];
  }
  if (!live.size) return [];
  const codes = await listCodes(room);
  const claimed = await claimedCodes(room);
  const out = await signedOutCodes(room, codes, claimed);
  return codes
    .filter((c) => live.has(c.streamId) && !out.has(c.code))
    .sort((a, b) => a.slot - b.slot)
    .map((c) => c.streamId);
}
