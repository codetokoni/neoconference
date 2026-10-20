// src/lib/partners/join.ts
//
// Letting a partner's visitor into their zone's meeting: the same rules as
// any join (src/app/api/livekit/token/route.ts) — the meeting's lock, its
// owner's participant cap, the waiting room and "wait for a host" — and a
// LiveKit token that can only ever make them a participant.

import { createHash } from "node:crypto";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { eventStore } from "@/lib/eventStore";
import { getPlanLimits, getPlanLimitsForUserId, type Plan } from "@/lib/plan";
import { featureDecisions } from "@/lib/platform/features";
import { reopensOnJoin } from "@/lib/meetingLifecycle";
import { gateStatus, noteKnock } from "@/lib/waitingRoom";
import type { NeoEvent, WaitingRoomEntry } from "@/types/event";
import { PartnerError, type JoinGrant } from "@/lib/partners/store";

/**
 * The visitor's identity in the room: fixed per (integration, partner user),
 * so a reload or a second tab replaces their own connection instead of
 * adding a duplicate, and never names them. Guests carry the id the
 * partner gave their visit.
 */
export function participantIdentity(grant: Pick<JoinGrant, "integrationId" | "externalUserId">): string {
  const h = createHash("sha256").update(`${grant.integrationId}:${grant.externalUserId}`).digest("hex").slice(0, 20);
  return `pz-${grant.integrationId.slice(3, 9)}-${h}`;
}

export type JoinOutcome =
  | { status: "ready"; token: string; wsUrl: string; title: string; displayName: string; room: string }
  | { status: "waiting_room" | "wait_for_host" | "denied"; title: string };

function livekit(): { svc: RoomServiceClient | null; apiKey: string; apiSecret: string; wsUrl: string } {
  const apiKey = process.env.LIVEKIT_API_KEY || "";
  const apiSecret = process.env.LIVEKIT_API_SECRET || "";
  const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL || "";
  if (!apiKey || !apiSecret || !wsUrl) throw new PartnerError(500, "not_configured", "Meetings are not configured.");
  const httpUrl = (process.env.LIVEKIT_URL || wsUrl).replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  let svc: RoomServiceClient | null = null;
  try {
    svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
  } catch {
    svc = null;
  }
  return { svc, apiKey, apiSecret, wsUrl };
}

/** People in the room now (humans only; captions and other agents do not count). Null when it cannot be told. */
async function humansIn(svc: RoomServiceClient | null, room: string): Promise<string[] | null> {
  if (!svc) return null;
  try {
    const parts = await svc.listParticipants(room);
    return parts
      .filter((p) => {
        if ((p as { kind?: unknown }).kind === 4) return false;
        const id = (p.identity || "").toLowerCase();
        return !id.startsWith("agent-") && !id.startsWith("neo-captions");
      })
      .map((p) => p.identity || "");
  } catch {
    return null;
  }
}

/** The visitor's place in the waiting room, knocking if they have not. */
async function knock(ev: NeoEvent, identity: string, name: string, now: number): Promise<"admitted" | "pending" | "denied"> {
  const entry = (ev.waitingRoom || []).find((e) => e.id === identity);
  const status = gateStatus(entry, now);
  if (status === "admitted" || status === "denied") return status;
  if (status === "not_knocked") {
    const fresh: WaitingRoomEntry = { id: identity, name, requestedAt: now, status: "pending" };
    await eventStore.update(ev.id, (prev) => ({
      ...prev,
      waitingRoom: [...(prev.waitingRoom || []).filter((e) => e.id !== identity), fresh],
      updatedAt: new Date().toISOString(),
    }));
  }
  // Still here: the host's list shows only people still knocking.
  await noteKnock(ev.id, identity, now).catch(() => {});
  return "pending";
}

/**
 * Lets the grant's visitor in, or says what they are waiting for. Run on
 * every join and every poll from the waiting screen, so a host's decision
 * or arrival is picked up.
 */
export async function joinZone(grant: JoinGrant, now = Date.now()): Promise<JoinOutcome> {
  let ev = await eventStore.byId(grant.eventId);
  if (!ev) throw new PartnerError(404, "meeting_not_found", "This meeting no longer exists.");
  const title = ev.name;
  const identity = participantIdentity(grant);
  const name = grant.verified ? grant.displayName : `${grant.displayName} (guest)`;

  // A finished session of a permanent room opens again for the next
  // visitor; any other finished meeting stays finished.
  if (ev.state === "ended") {
    if (!reopensOnJoin(ev)) throw new PartnerError(409, "meeting_ended", "This meeting has ended.");
    ev = (await eventStore.update(ev.id, { state: "live" } as Partial<NeoEvent>)) ?? ev;
  }
  if (ev.isLocked) throw new PartnerError(403, "meeting_locked", "This meeting is locked. Ask the host to unlock it.");

  const { svc, apiKey, apiSecret, wsUrl } = livekit();
  const room = ev.livekitRoom || ev.slug;
  const present = await humansIn(svc, room);

  // The owner's plan caps how many can be in. Fails open when the room
  // cannot be read, like the main join route.
  const { plan, limits } = await getPlanLimitsForUserId(ev.ownerUserId).catch(() => ({ plan: "free" as Plan, limits: getPlanLimits("free") }));
  if (present && limits.maxParticipants > 0) {
    const others = present.filter((id) => id !== identity).length;
    if (others >= limits.maxParticipants) {
      throw new PartnerError(403, "room_full", `This meeting is full (${limits.maxParticipants} people).`);
    }
  }

  if (ev.waitingRoomEnabled) {
    const status = await knock(ev, identity, name, now);
    if (status === "denied") return { status: "denied", title };
    if (status === "pending") return { status: "waiting_room", title };
  }
  if (ev.waitForHost !== false && present !== null && present.filter((id) => id !== identity).length === 0) {
    return { status: "wait_for_host", title };
  }

  const at = new AccessToken(apiKey, apiSecret, { identity, name, ttl: "2h" });
  // A participant, whatever the partner or the browser says.
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  const planLimits = { ...limits };
  try {
    const switches = ["recording", "breakouts", "livestream", "translation", "branding"] as const;
    const fx = await featureDecisions([...switches], {
      userId: ev.ownerUserId,
      plan,
      planAllows: Object.fromEntries(switches.map((f) => [f, planLimits[f]])),
    });
    for (const f of switches) planLimits[f] = fx[f].enabled;
  } catch (e) {
    console.error("[partners] feature controls unavailable", e);
  }
  at.metadata = JSON.stringify({
    planLimits,
    hostPlan: plan,
    role: "attendee",
    partner: { integrationId: grant.integrationId, verified: grant.verified },
  });
  return { status: "ready", token: await at.toJwt(), wsUrl, title, displayName: name, room };
}
