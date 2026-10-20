// src/lib/partners/embedCaller.ts — server side of embedAuth: who a
// request from the partner embed is, and the one room it may act in.

import { eventStore } from "@/lib/eventStore";
import { EMBED_SESSION_HEADER } from "@/lib/partners/embedAuth";
import { getIntegration, getZone, verifySession } from "@/lib/partners/store";
import { participantIdentity } from "@/lib/partners/join";

export type EmbedCaller = { identity: string; room: string; integrationId: string };

/** The embed visitor behind this request, or null (no header, or not a valid session). */
export async function embedCaller(req: Request): Promise<EmbedCaller | null> {
  const raw = req.headers.get(EMBED_SESSION_HEADER);
  if (!raw) return null;
  try {
    const grant = verifySession(raw);
    const integration = await getIntegration(grant.integrationId);
    if (!integration || integration.status !== "active") return null;
    const zone = await getZone(grant.integrationId, grant.zoneId);
    if (!zone || zone.status !== "active" || zone.eventId !== grant.eventId) return null;
    const ev = await eventStore.byId(grant.eventId);
    if (!ev) return null;
    return { identity: participantIdentity(grant), room: ev.livekitRoom || ev.slug, integrationId: grant.integrationId };
  } catch {
    return null;
  }
}
