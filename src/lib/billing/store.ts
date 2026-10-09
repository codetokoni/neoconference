// src/lib/billing/store.ts
//
// The plan catalog and what is sold with it, in KV:
//
//   neo:plans:defs         hash  planId -> PlanDef
//   neo:plans:v:<planId>   hash  version -> PlanVersion
//   neo:coupons            hash  CODE -> Coupon
//   neo:coupon:n:<CODE>    counter of redemptions (paid checkouts)
//   neo:coupon:u:<CODE>    set of userIds who redeemed it
//   neo:offers             hash  id -> Offer
//   neo:addons             hash  id -> AddOn
//
// The five tiers exist before anyone saves them: an unsaved tier reads as
// its built-in version 1 (model.ts defaultTier), and the first edit stores
// that version 1 next to the new one, so history starts at what accounts
// already had. Plans are archived, never deleted: a subscription names its
// plan and version for as long as it exists.

import { kv } from "@/lib/kv";
import { PLANS, type Plan, type PlanFeatureLimits } from "@/lib/planLimits";
import {
  defaultTier,
  isTierId,
  type AddOn,
  type CatalogPlan,
  type Coupon,
  type Offer,
  type PlanDef,
  type PlanTerms,
  type PlanVersion,
} from "@/lib/billing/model";

const DEFS = "neo:plans:defs";
const versionsKey = (id: string) => `neo:plans:v:${id}`;
const COUPONS = "neo:coupons";
const couponCount = (code: string) => `neo:coupon:n:${code}`;
const couponUsers = (code: string) => `neo:coupon:u:${code}`;
const OFFERS = "neo:offers";
const ADDONS = "neo:addons";

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

async function hashValues<T>(key: string): Promise<T[]> {
  const all = ((await kv.hgetall(key)) ?? {}) as Record<string, unknown>;
  return Object.values(all)
    .map((v) => parse<T>(v))
    .filter((v): v is T => !!v);
}

/* ---------------------------------- plans --------------------------------- */

async function storedDefs(): Promise<Map<string, PlanDef>> {
  return new Map((await hashValues<PlanDef>(DEFS)).map((d) => [d.id, d]));
}

export async function getPlanDef(id: string): Promise<PlanDef | null> {
  const stored = parse<PlanDef>(await kv.hget(DEFS, id));
  if (stored) return stored;
  return isTierId(id) ? defaultTier(id).def : null;
}

export async function getVersion(id: string, version: number): Promise<PlanVersion | null> {
  const stored = parse<PlanVersion>(await kv.hget(versionsKey(id), String(version)));
  if (stored) return stored;
  return isTierId(id) && version === 1 ? defaultTier(id).version : null;
}

export async function listVersions(id: string): Promise<PlanVersion[]> {
  const stored = await hashValues<PlanVersion>(versionsKey(id));
  if (isTierId(id) && !stored.some((v) => v.version === 1)) stored.push(defaultTier(id).version);
  return stored.sort((a, b) => b.version - a.version);
}

export async function getPlan(id: string): Promise<CatalogPlan | null> {
  const def = await getPlanDef(id);
  if (!def) return null;
  const current = (await getVersion(id, def.currentVersion)) ?? (isTierId(id) ? defaultTier(id).version : null);
  return current ? { ...def, current } : null;
}

/** Every plan, archived ones included, in display order. */
export async function listPlans(): Promise<CatalogPlan[]> {
  const defs = await storedDefs();
  for (const t of PLANS) if (!defs.has(t)) defs.set(t, defaultTier(t).def);
  const out: CatalogPlan[] = [];
  for (const def of defs.values()) {
    const current = (await getVersion(def.id, def.currentVersion)) ?? (isTierId(def.id) ? defaultTier(def.id).version : null);
    if (current) out.push({ ...def, current });
  }
  return out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export async function saveDef(def: PlanDef): Promise<void> {
  await kv.hset(DEFS, { [def.id]: JSON.stringify(def) });
}

/** Store new terms as the next version and make it current. */
export async function addVersion(
  def: PlanDef,
  terms: PlanTerms,
  by: string,
  note?: string,
): Promise<{ def: PlanDef; version: PlanVersion }> {
  const existing = await listVersions(def.id);
  // An unsaved tier's version 1 is only virtual until now.
  if (isTierId(def.id) && !(await kv.hget(versionsKey(def.id), "1"))) {
    await kv.hset(versionsKey(def.id), { "1": JSON.stringify(defaultTier(def.id).version) });
  }
  const next = Math.max(0, ...existing.map((v) => v.version)) + 1;
  const now = Date.now();
  const version: PlanVersion = { ...terms, planId: def.id, version: next, createdAt: now, createdBy: by, ...(note ? { note } : {}) };
  await kv.hset(versionsKey(def.id), { [String(next)]: JSON.stringify(version) });
  const updated: PlanDef = { ...def, currentVersion: next, updatedAt: now };
  await saveDef(updated);
  return { def: updated, version };
}

/** A brand-new plan (not one of the tiers) with its version 1. */
export async function createPlan(
  input: { id: string; baseTier: Plan; selfServe: boolean; public: boolean; highlight: boolean },
  terms: PlanTerms,
  by: string,
): Promise<CatalogPlan> {
  const now = Date.now();
  const all = await listPlans();
  const def: PlanDef = {
    ...input,
    archived: false,
    order: Math.max(0, ...all.map((p) => p.order)) + 1,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: by,
  };
  const version: PlanVersion = { ...terms, planId: def.id, version: 1, createdAt: now, createdBy: by };
  await kv.hset(versionsKey(def.id), { "1": JSON.stringify(version) });
  await saveDef(def);
  return { ...def, current: version };
}

/** Put the listed plans first, in that order; the rest keep their order after them. */
export async function reorderPlans(ids: string[]): Promise<CatalogPlan[]> {
  const all = await listPlans();
  const rank = new Map(ids.map((id, i) => [id, i]));
  const sorted = [...all].sort((a, b) => (rank.get(a.id) ?? 1e6 + a.order) - (rank.get(b.id) ?? 1e6 + b.order));
  const now = Date.now();
  for (let i = 0; i < sorted.length; i++) {
    const { current: _c, ...def } = sorted[i];
    void _c;
    if (def.order !== i) await saveDef({ ...def, order: i, updatedAt: now });
  }
  return listPlans();
}

/* ---- the Free plan, for accounts with no subscription ---- */

// Free has no buyers to protect: its current version is what every account
// without a paid plan gets. Read on hot paths (joining a meeting), so it is
// remembered for a short while per server instance.
let freeCache: { at: number; limits: PlanFeatureLimits } | null = null;
const FREE_TTL_MS = 30_000;

export async function currentFreeLimits(): Promise<PlanFeatureLimits> {
  if (freeCache && Date.now() - freeCache.at < FREE_TTL_MS) return freeCache.limits;
  const plan = await getPlan("free");
  const limits = plan?.current.limits ?? defaultTier("free").version.limits;
  freeCache = { at: Date.now(), limits };
  return limits;
}

export function forgetFreeLimits(): void {
  freeCache = null;
}

/* --------------------------------- coupons -------------------------------- */

export async function listCoupons(): Promise<(Coupon & { redemptions: number })[]> {
  const all = await hashValues<Coupon>(COUPONS);
  const out = [];
  for (const c of all) out.push({ ...c, redemptions: await couponRedemptions(c.code) });
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getCoupon(code: string): Promise<Coupon | null> {
  return parse<Coupon>(await kv.hget(COUPONS, code.trim().toUpperCase()));
}

export async function saveCoupon(c: Coupon): Promise<void> {
  await kv.hset(COUPONS, { [c.code]: JSON.stringify(c) });
}

export async function deleteCoupon(code: string): Promise<void> {
  await kv.hdel(COUPONS, code);
}

export async function couponRedemptions(code: string): Promise<number> {
  return Number((await kv.get(couponCount(code))) ?? 0);
}

export async function couponUsedBy(code: string, userId: string): Promise<boolean> {
  return Number(await kv.sismember(couponUsers(code), userId)) === 1;
}

/** Count one paid redemption. Called once per completed checkout. */
export async function redeemCoupon(code: string, userId: string): Promise<number> {
  const n = Number(await kv.incr(couponCount(code)));
  await kv.sadd(couponUsers(code), userId);
  return n;
}

/* --------------------------------- offers --------------------------------- */

export async function listOffers(): Promise<Offer[]> {
  return (await hashValues<Offer>(OFFERS)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getOffer(id: string): Promise<Offer | null> {
  return parse<Offer>(await kv.hget(OFFERS, id));
}

export async function saveOffer(o: Offer): Promise<void> {
  await kv.hset(OFFERS, { [o.id]: JSON.stringify(o) });
}

export async function deleteOffer(id: string): Promise<void> {
  await kv.hdel(OFFERS, id);
}

/* --------------------------------- add-ons -------------------------------- */

export async function listAddOns(): Promise<AddOn[]> {
  return (await hashValues<AddOn>(ADDONS)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAddOn(id: string): Promise<AddOn | null> {
  return parse<AddOn>(await kv.hget(ADDONS, id));
}

export async function saveAddOn(a: AddOn): Promise<void> {
  await kv.hset(ADDONS, { [a.id]: JSON.stringify(a) });
}

export function newId(prefix: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${prefix}-${slug || "item"}-${Math.random().toString(36).slice(2, 7)}`;
}
