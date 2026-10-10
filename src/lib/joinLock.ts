import { kv } from "@/lib/kv";

/**
 * The join page lock, per room. While locked, codes do not let anyone new
 * in; a device that already holds its code may still rejoin (a reload or a
 * dropped connection must not throw out someone who is already in).
 *
 *   neo:video:joinlock:<room>  { locked, at, by }   absent = open
 */
export interface JoinLock {
  locked: boolean;
  at: number;
  by?: string;
}

const lockKey = (room: string) => `neo:video:joinlock:${room}`;

export async function getJoinLock(room: string): Promise<JoinLock> {
  const raw = await kv.get<JoinLock | string>(lockKey(room));
  if (!raw) return { locked: false, at: 0 };
  const v = typeof raw === "string" ? (JSON.parse(raw) as JoinLock) : raw;
  return { locked: Boolean(v.locked), at: Number(v.at) || 0, by: v.by };
}

export async function setJoinLock(room: string, locked: boolean, by: string): Promise<JoinLock> {
  const v: JoinLock = { locked, at: Date.now(), by };
  if (locked) await kv.set(lockKey(room), JSON.stringify(v));
  else await kv.del(lockKey(room));
  return v;
}
