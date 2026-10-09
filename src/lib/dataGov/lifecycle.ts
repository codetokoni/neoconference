// src/lib/dataGov/lifecycle.ts
//
// The moves a deletion request makes, shared by the person's own account
// page (/api/me/data/deletion), phase 2's account page actions and the
// /admin/data queue:
//
//   request  -> "requested" (grace period from the accounts retention setting)
//   cancel   -> "cancelled" (by the person, if they asked; or an administrator)
//   hold     -> "refused"   (a legal hold; the request is closed, the hold stays)
//   complete -> "completed" (src/lib/dataGov/actions.ts completeDeletion)
//
// A request the person makes leaves the account usable during the grace
// period, so they can change their mind on the same page. One an
// administrator makes suspends the account (phase 2's behaviour).

import { clerkClient } from "@clerk/nextjs/server";
import { setSuspension, type ClerkUserish } from "@/lib/admin/users";
import { isOwnerEmailList } from "@/lib/admin/owner";
import { closeRequest, createRequest, getHold, getRequest, logClosed, requestId, setHold, type ClosedRequest, type DeletionRequest, type LegalHold } from "@/lib/dataGov/requests";

export type SelfRequestResult =
  | { ok: true; request: DeletionRequest; unchanged?: true }
  | { ok: false; error: "owner_protected" | "refused"; closed?: ClosedRequest };

/** The person asks for their own account to be deleted. */
export async function requestBySelf(user: ClerkUserish, reason: string, now = Date.now()): Promise<SelfRequestResult> {
  // Server-side, whatever the page shows: the owner's account is never deleted.
  if (isOwnerEmailList(user.emailAddresses)) return { ok: false, error: "owner_protected" };
  const existing = await getRequest(user.id);
  if (existing) return { ok: true, request: existing, unchanged: true };
  if (await getHold(user.id)) {
    const closed: ClosedRequest = {
      id: requestId(user.id, now),
      userId: user.id,
      status: "refused",
      source: "user",
      requestedAt: now,
      deleteAfter: now,
      closedAt: now,
      closedBy: "system",
      note: "legal hold",
    };
    await logClosed(closed);
    return { ok: false, error: "refused", closed };
  }
  const request = await createRequest(user.id, {
    source: "user",
    byId: user.id,
    byEmail: "",
    reason: reason || "Requested by the account holder",
    // Not suspended by a self-service request, so cancelling never lifts a suspension.
    wasBanned: true,
  }, now);
  return { ok: true, request };
}

/** Lift the suspension the request itself put on, if it did. */
async function liftRequestSuspension(uid: string, d: DeletionRequest): Promise<boolean> {
  if (d.source === "user" || d.wasBanned) return false;
  const client = await clerkClient();
  const u = (await client.users.getUser(uid)) as unknown as ClerkUserish;
  if (!u.banned) return false;
  await client.users.unbanUser(uid);
  await setSuspension(uid, null);
  return true;
}

export async function cancelRequest(uid: string, by: "user" | string): Promise<{ ok: true; closed: ClosedRequest; reactivated: boolean } | { ok: false; error: "not_requested" | "not_yours" }> {
  const d = await getRequest(uid);
  if (!d) return { ok: false, error: "not_requested" };
  // The person can take back their own request, not one an administrator made.
  if (by === "user" && d.source !== "user") return { ok: false, error: "not_yours" };
  const reactivated = await liftRequestSuspension(uid, d);
  const closed = await closeRequest(uid, d, "cancelled", by);
  return { ok: true, closed, reactivated };
}

/** Put a legal hold on: an open request is refused and closed. */
export async function placeHold(uid: string, hold: LegalHold): Promise<{ refused: ClosedRequest | null; reactivated: boolean }> {
  await setHold(uid, hold);
  const d = await getRequest(uid);
  if (!d) return { refused: null, reactivated: false };
  const reactivated = await liftRequestSuspension(uid, d);
  const refused = await closeRequest(uid, d, "refused", hold.byId, { note: "legal hold" });
  return { refused, reactivated };
}

export async function releaseHold(uid: string): Promise<LegalHold | null> {
  const h = await getHold(uid);
  if (h) await setHold(uid, null);
  return h;
}
