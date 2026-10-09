// src/lib/billing/adminInput.ts — turning admin form input into coupons,
// offers and add-ons. Each returns the record, or a message saying what is
// wrong. `existing` is the record being edited (fields left out keep their
// value), or null when creating.

import {
  COUPON_RE,
  cleanCycles,
  cleanDiscount,
  cleanGrants,
  cleanIds,
  cleanPrices,
  cleanTime,
  type AddOn,
  type Coupon,
  type Offer,
} from "@/lib/billing/model";
import { newId } from "@/lib/billing/store";

type Raw = Record<string, unknown>;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const has = (r: Raw, k: string) => r[k] !== undefined;

/** A record without its bookkeeping fields, for the audit log. */
export function strip<T extends { createdAt: number; updatedAt: number; createdBy: string }>(r: T): Omit<T, "createdAt" | "updatedAt" | "createdBy"> {
  const out = { ...r } as Partial<T>;
  delete out.createdAt;
  delete out.updatedAt;
  delete out.createdBy;
  return out as Omit<T, "createdAt" | "updatedAt" | "createdBy">;
}

function windowOf(r: Raw, startKey: string, endKey: string, prev: { start: number | null; end: number | null }) {
  const start = has(r, startKey) ? cleanTime(r[startKey]) : prev.start;
  const end = has(r, endKey) ? cleanTime(r[endKey]) : prev.end;
  return start && end && end <= start ? null : { start, end };
}

export function cleanCoupon(r: Raw, existing: Coupon | null, by: string): Coupon | string {
  const now = Date.now();
  const code = existing ? existing.code : text(r.code, 32).toUpperCase();
  if (!COUPON_RE.test(code)) return "A code is 3–32 letters, digits, dashes or underscores.";
  const d = has(r, "kind") || has(r, "value") || !existing ? cleanDiscount({ kind: r.kind ?? existing?.kind, value: r.value ?? existing?.value }) : existing;
  if (typeof d === "string") return d;
  const w = windowOf(r, "startsAt", "expiresAt", { start: existing?.startsAt ?? null, end: existing?.expiresAt ?? null });
  if (!w) return "The coupon must expire after it starts.";
  let maxRedemptions = existing?.maxRedemptions ?? null;
  if (has(r, "maxRedemptions")) {
    if (r.maxRedemptions === null || r.maxRedemptions === "") maxRedemptions = null;
    else {
      const n = Number(r.maxRedemptions);
      if (!Number.isInteger(n) || n < 1) return "Max redemptions must be a whole number of at least 1, or empty for no limit.";
      maxRedemptions = n;
    }
  }
  return {
    code,
    description: has(r, "description") ? text(r.description, 300) : existing?.description ?? "",
    kind: d.kind,
    value: d.value,
    planIds: has(r, "planIds") ? cleanIds(r.planIds) : existing?.planIds ?? [],
    cycles: has(r, "cycles") ? cleanCycles(r.cycles) : existing?.cycles ?? [],
    startsAt: w.start,
    expiresAt: w.end,
    maxRedemptions,
    oncePerUser: has(r, "oncePerUser") ? r.oncePerUser === true : existing?.oncePerUser ?? true,
    active: has(r, "active") ? r.active === true : existing?.active ?? true,
    createdAt: existing?.createdAt ?? now,
    createdBy: existing?.createdBy ?? by,
    updatedAt: now,
  };
}

export function cleanOffer(r: Raw, existing: Offer | null, by: string): Offer | string {
  const now = Date.now();
  const name = has(r, "name") ? text(r.name, 80) : existing?.name ?? "";
  if (!name) return "Give the offer a name.";
  const d = has(r, "kind") || has(r, "value") || !existing ? cleanDiscount({ kind: r.kind ?? existing?.kind, value: r.value ?? existing?.value }) : existing;
  if (typeof d === "string") return d;
  const w = windowOf(r, "startsAt", "endsAt", { start: existing?.startsAt ?? null, end: existing?.endsAt ?? null });
  if (!w) return "The offer must end after it starts.";
  return {
    id: existing?.id ?? newId("offer", name),
    name,
    label: has(r, "label") ? text(r.label, 80) : existing?.label ?? "",
    kind: d.kind,
    value: d.value,
    planIds: has(r, "planIds") ? cleanIds(r.planIds) : existing?.planIds ?? [],
    cycles: has(r, "cycles") ? cleanCycles(r.cycles) : existing?.cycles ?? [],
    startsAt: w.start,
    endsAt: w.end,
    active: has(r, "active") ? r.active === true : existing?.active ?? true,
    createdAt: existing?.createdAt ?? now,
    createdBy: existing?.createdBy ?? by,
    updatedAt: now,
  };
}

export function cleanAddOn(r: Raw, existing: AddOn | null, by: string): AddOn | string {
  const now = Date.now();
  const name = has(r, "name") ? text(r.name, 80) : existing?.name ?? "";
  if (!name) return "Give the add-on a name.";
  const grants = has(r, "grants") ? cleanGrants(r.grants) : existing?.grants ?? {};
  if (!Object.keys(grants).length) return "An add-on must grant something: extra participants, recording hours, members, seats, storage or a feature.";
  return {
    id: existing?.id ?? newId("addon", name),
    name,
    description: has(r, "description") ? text(r.description, 300) : existing?.description ?? "",
    prices: has(r, "prices") ? cleanPrices(r.prices) : existing?.prices ?? {},
    grants,
    planIds: has(r, "planIds") ? cleanIds(r.planIds) : existing?.planIds ?? [],
    archived: has(r, "archived") ? r.archived === true : existing?.archived ?? false,
    createdAt: existing?.createdAt ?? now,
    createdBy: existing?.createdBy ?? by,
    updatedAt: now,
  };
}
