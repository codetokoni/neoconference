// src/lib/partners/admin.ts — what the admin Partner zones screen needs:
// reading an integration whole, checking an administrator's input, and
// finding the account an email belongs to. No secret leaves here: keys are
// listed masked, and a new key is returned once by the route that made it.

import { clerkClient } from "@clerk/nextjs/server";
import { fail } from "@/lib/admin/http";
import {
  PartnerError,
  getIntegration,
  listAudit,
  listPartnerKeys,
  listZones,
  normalizeOrigin,
  type IntegrationPatch,
  type PartnerIntegration,
} from "@/lib/partners/store";

/** The account behind an email address, or a 404 the screen can show. */
export async function accountByEmail(raw: unknown): Promise<{ userId: string; email: string }> {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PartnerError(400, "invalid_email", "Enter the owner's email address.");
  const cc = await clerkClient();
  const list = await cc.users.getUserList({ emailAddress: [email], limit: 1 });
  const user = list.data?.[0];
  if (!user) throw new PartnerError(404, "owner_not_found", `No account uses ${email}. The owner must sign up first.`);
  return { userId: user.id, email };
}

/** Approved websites from a list or one per line; every one must be a site origin. */
export function readOrigins(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" || !item.trim()) continue;
    const o = normalizeOrigin(item.trim());
    if (!o) {
      throw new PartnerError(
        400,
        "invalid_origin",
        `${item.trim().slice(0, 100)} is not a website origin. Use https://name.example (no path); http only for localhost.`,
      );
    }
    if (!out.includes(o)) out.push(o);
  }
  if (out.length > 20) throw new PartnerError(400, "too_many_origins", "At most 20 websites per integration.");
  return out;
}

function readName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > 80) throw new PartnerError(400, "invalid_name", "Give the integration a name (up to 80 characters).");
  return name;
}

function readTemplate(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t || t.length > 80) throw new PartnerError(400, "invalid_title", "The meeting title needs 1–80 characters; {zone} becomes the zone id.");
  return t;
}

/** The fields an administrator may set at creation. */
export async function readCreate(body: Record<string, unknown>) {
  const owner = await accountByEmail(body.ownerEmail);
  return {
    name: readName(body.name),
    ownerUserId: owner.userId,
    ownerEmail: owner.email,
    origins: readOrigins(body.origins),
    autoCreateZones: body.autoCreateZones === undefined ? true : body.autoCreateZones === true,
    guestAccess: body.guestAccess === true,
    titleTemplate: body.titleTemplate === undefined || body.titleTemplate === "" ? "{zone} Meeting" : readTemplate(body.titleTemplate),
  };
}

/** The fields present in an update, checked. Absent fields stay as they are. */
export async function readPatch(body: Record<string, unknown>): Promise<IntegrationPatch> {
  const patch: IntegrationPatch = {};
  if ("name" in body) patch.name = readName(body.name);
  if ("origins" in body) patch.origins = readOrigins(body.origins);
  if ("autoCreateZones" in body) patch.autoCreateZones = body.autoCreateZones === true;
  if ("guestAccess" in body) patch.guestAccess = body.guestAccess === true;
  if ("titleTemplate" in body) patch.titleTemplate = readTemplate(body.titleTemplate);
  if ("status" in body) {
    if (body.status !== "active" && body.status !== "disabled") throw new PartnerError(400, "invalid_status", "Status is active or disabled.");
    patch.status = body.status;
  }
  if ("ownerEmail" in body) {
    const owner = await accountByEmail(body.ownerEmail);
    patch.ownerUserId = owner.userId;
    patch.ownerEmail = owner.email;
  }
  if (!Object.keys(patch).length) throw new PartnerError(400, "nothing_to_change", "Nothing to change.");
  return patch;
}

/** One integration with everything the screen shows about it. */
export async function integrationDetail(id: string) {
  const integration = await getIntegration(id);
  if (!integration) throw new PartnerError(404, "integration_not_found", "No such integration.");
  const [keys, zones, audit] = await Promise.all([listPartnerKeys(id), listZones(id), listAudit(id, 100)]);
  return { integration, keys, zones, audit };
}

/** What changed, for the admin audit log: field names and values, none of them secret. */
export function changes(before: PartnerIntegration, patch: IntegrationPatch) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(patch) as (keyof IntegrationPatch)[]) {
    b[k] = before[k];
    a[k] = patch[k];
  }
  return { before: b, after: a };
}

/** "falf-prayer", "/falf-prayer" or "https://neolinguameet.com/falf-prayer" -> "falf-prayer". */
export function meetingSlug(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  let path = s;
  if (/^https?:\/\//i.test(s)) {
    try {
      path = new URL(s).pathname;
    } catch {
      path = s;
    }
  }
  const slug = path.replace(/^\/+|\/+$/g, "").replace(/^(room|e)\//, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) throw new PartnerError(400, "invalid_meeting", "Give the meeting's address, like falf-prayer, or its link.");
  return slug;
}

/** A refusal in the admin routes' shape ({ error, message }). */
export function adminFail(e: unknown) {
  if (e instanceof PartnerError) return fail(e.code, e.message, e.status);
  console.error("[admin partners]", e);
  return fail("server_error", "Something went wrong. Try again.", 500);
}
