// src/lib/translationGate.ts
//
// Whether a meeting may use live translation. It is on the Pro plan and
// above, by the plan of the meeting's OWNER (listeners never need a plan),
// with the admin feature controls on top: the same decision the meeting
// token carries as planLimits.translation, and the one creating a meeting
// with languages already made (src/app/api/events/create/route.ts).
//
// /api/translate asks this for every caption it translates, so the answer
// is kept per room for a few minutes rather than looking the owner up in
// Clerk each time. A room with no meeting behind it has no owner and so no
// plan: no translation.

import { eventStore } from "@/lib/eventStore";
import { getPlanLimitsForUserId } from "@/lib/plan";
import { featureDecision } from "@/lib/platform/features";

export const TRANSLATION_CACHE_MS = 5 * 60_000;

type Answer = { allowed: boolean; plan: string | null };
const cache = new Map<string, { at: number; answer: Answer }>();

/** Test hook: forget every cached answer. */
export function __clearTranslationGate(): void {
  cache.clear();
}

export async function translationAllowedFor(room: string, now: number = Date.now()): Promise<Answer> {
  const key = room.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < TRANSLATION_CACHE_MS) return hit.answer;

  let answer: Answer = { allowed: false, plan: null };
  const ev = key ? await eventStore.bySlug(key) : null;
  if (ev?.ownerUserId) {
    const { plan, limits } = await getPlanLimitsForUserId(ev.ownerUserId);
    const decision = await featureDecision("translation", { userId: ev.ownerUserId, plan, planAllows: limits.translation });
    answer = { allowed: decision.enabled, plan };
  }
  cache.set(key, { at: now, answer });
  if (cache.size > 2000) {
    for (const [k, v] of cache) if (now - v.at >= TRANSLATION_CACHE_MS) cache.delete(k);
  }
  return answer;
}
