// src/lib/appVersionCounts.ts
//
// How many people ask to join a meeting from each version of the Android
// app, per UTC day, so the owner can see when an old version has gone and
// MIN_APP_VERSION (src/lib/appRelease.ts) can rise without shutting anyone out.
//
//   neo:app-versions:<YYYY-MM-DD>              set of "v<version>" seen that day
//   neo:app-versions:<YYYY-MM-DD>:v<version>   HyperLogLog of the people
//
// Counted at /api/livekit/token, which every join asks first and where the
// app names itself (?client=android 1.2.10+5224 …); refused old apps count
// too, since they are exactly what the minimum decides. The website sends no
// client and is not counted. A HyperLogLog keeps a count of distinct people
// without keeping who they were. Before 2026-11-06 nothing recorded this:
// a join's record carried the version only when it came by webhook with
// the token's metadata, 41 of 30,124 joins in the week before.

import { kv } from "@/lib/kv";
import { appVersionOf, compareVersions } from "@/lib/appRelease";

const TTL_S = 120 * 24 * 60 * 60;
const dayKey = (day: string) => `neo:app-versions:${day}`;
// "v" in front: Upstash JSON-parses what it reads back, and "1.2" would come back as a number.
const versionKey = (day: string, version: string) => `${dayKey(day)}:v${version}`;

export const utcDayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Count this person's join under their app's version today. Never throws. */
export async function recordAppJoin(client: string, person: string | null, now = Date.now()): Promise<void> {
  const version = appVersionOf(client);
  if (!version || !person) return;
  const day = utcDayOf(now);
  try {
    await Promise.all([
      kv.sadd(dayKey(day), `v${version}`),
      kv.pfadd(versionKey(day, version), person),
      kv.expire(dayKey(day), TTL_S),
      kv.expire(versionKey(day, version), TTL_S),
    ]);
  } catch (e) {
    console.warn("[app-versions] not counted", e instanceof Error ? e.message : e);
  }
}

export interface AppVersionCount {
  version: string;
  /** Distinct people over the days asked for. */
  people: number;
}

/** People per app version over `days` (UTC dates), newest version first. */
export async function appVersionsOver(days: string[]): Promise<AppVersionCount[]> {
  const seen = new Map<string, string[]>(); // version -> its day keys
  for (const day of days) {
    const members = ((await kv.smembers(dayKey(day))) ?? []) as unknown[];
    for (const m of members) {
      const version = String(m).replace(/^v/, "");
      if (!/^\d+(\.\d+){0,3}$/.test(version)) continue;
      seen.set(version, [...(seen.get(version) ?? []), versionKey(day, version)]);
    }
  }
  const out: AppVersionCount[] = [];
  for (const [version, keys] of seen) out.push({ version, people: Number(await kv.pfcount(...(keys as [string, ...string[]]))) || 0 });
  return out.sort((a, b) => compareVersions(b.version, a.version));
}
