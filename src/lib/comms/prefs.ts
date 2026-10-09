// src/lib/comms/prefs.ts
//
// What each person agreed to hear about, per category and channel.
//
//   neo:comms:prefs:<uid>   JSON  { [category]: { email, inApp, push }, updatedAt, updatedVia }
//
// Only these categories can be turned off. Transactional email (meeting
// invitations, changes, sign-in and security notices, receipts) and
// service notices an administrator marks as such are not in the list, so
// nothing here can stop them.
//
// Every announcement email carries an unsubscribe link with a signed token
// (no sign-in needed): HMAC over the user id and category, keyed from
// COMMS_SIGNING_KEY, else CLERK_SECRET_KEY.

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { kv } from "@/lib/kv";

export const PREF_CATEGORIES = [
  { key: "announcements", label: "Announcements", description: "News about NeoConference: events, changes to the service, planned maintenance." },
  { key: "product", label: "Product updates", description: "New features and tips for getting more out of your meetings." },
  { key: "reminders", label: "Usage reminders", description: "When you are close to your plan's meeting or recording allowance." },
] as const;

export type PrefCategory = (typeof PREF_CATEGORIES)[number]["key"];
export const PREF_CHANNELS = ["email", "inApp", "push"] as const;
export type PrefChannel = (typeof PREF_CHANNELS)[number];

export type ChannelPrefs = Record<PrefChannel, boolean>;
export interface Prefs {
  categories: Record<PrefCategory, ChannelPrefs>;
  updatedAt: number | null;
  updatedVia: "settings" | "unsubscribe_link" | "complaint" | "admin" | null;
}

export function isPrefCategory(v: unknown): v is PrefCategory {
  return typeof v === "string" && PREF_CATEGORIES.some((c) => c.key === v);
}

const key = (uid: string) => `neo:comms:prefs:${uid}`;

export function defaultPrefs(): Prefs {
  const on: ChannelPrefs = { email: true, inApp: true, push: true };
  return {
    categories: { announcements: { ...on }, product: { ...on }, reminders: { ...on } },
    updatedAt: null,
    updatedVia: null,
  };
}

function normalise(raw: unknown): Prefs {
  const base = defaultPrefs();
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return base;
    }
  }
  if (!o || typeof o !== "object") return base;
  const r = o as Partial<Prefs>;
  for (const c of PREF_CATEGORIES) {
    const v = r.categories?.[c.key];
    if (!v) continue;
    for (const ch of PREF_CHANNELS) if (typeof v[ch] === "boolean") base.categories[c.key][ch] = v[ch];
  }
  base.updatedAt = typeof r.updatedAt === "number" ? r.updatedAt : null;
  base.updatedVia = r.updatedVia ?? null;
  return base;
}

export async function getPrefs(uid: string): Promise<Prefs> {
  if (!uid) return defaultPrefs();
  return normalise(await kv.get(key(uid)));
}

/** Apply a partial change ({ announcements: { email: false } }) and return the result. */
export async function updatePrefs(uid: string, patch: unknown, via: NonNullable<Prefs["updatedVia"]>): Promise<{ before: Prefs; after: Prefs }> {
  const before = await getPrefs(uid);
  const after: Prefs = JSON.parse(JSON.stringify(before));
  if (patch && typeof patch === "object") {
    for (const [cat, chans] of Object.entries(patch as Record<string, unknown>)) {
      if (!isPrefCategory(cat) || !chans || typeof chans !== "object") continue;
      for (const ch of PREF_CHANNELS) {
        const v = (chans as Record<string, unknown>)[ch];
        if (typeof v === "boolean") after.categories[cat][ch] = v;
      }
    }
  }
  after.updatedAt = Date.now();
  after.updatedVia = via;
  await kv.set(key(uid), JSON.stringify(after));
  return { before, after };
}

/**
 * Whether `uid` takes messages of `category` on `channel`. A category of
 * null is transactional or a service notice: always yes.
 */
export function allows(p: Prefs, category: PrefCategory | null, channel: PrefChannel): boolean {
  if (category == null) return true;
  return p.categories[category][channel];
}

/* ----------------------------- unsubscribe ----------------------------- */

function signingKey(): Buffer {
  const s = process.env.COMMS_SIGNING_KEY || process.env.CLERK_SECRET_KEY;
  if (!s) throw new Error("COMMS_SIGNING_KEY or CLERK_SECRET_KEY must be set to sign unsubscribe links");
  return Buffer.from(hkdfSync("sha256", s, "neo-comms", "unsubscribe", 32));
}

function mac(uid: string, category: string): string {
  return createHmac("sha256", signingKey()).update(`${uid}\n${category}`).digest("base64url").slice(0, 32);
}

/** A token that unsubscribes `uid` from `category` emails. It does not expire. */
export function unsubscribeToken(uid: string, category: PrefCategory): string {
  return `${Buffer.from(uid).toString("base64url")}.${category}.${mac(uid, category)}`;
}

export function readUnsubscribeToken(token: string | null | undefined): { uid: string; category: PrefCategory } | null {
  if (!token || token.length > 400) return null;
  const [u, category, sig] = token.split(".");
  if (!u || !sig || !isPrefCategory(category)) return null;
  const uid = Buffer.from(u, "base64url").toString("utf8");
  if (!/^[\w-]{1,100}$/.test(uid)) return null;
  const want = Buffer.from(mac(uid, category));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return { uid, category };
}

export function unsubscribeUrl(origin: string, uid: string, category: PrefCategory): string {
  return `${origin.replace(/\/+$/, "")}/unsubscribe?t=${encodeURIComponent(unsubscribeToken(uid, category))}`;
}

/** The one-click address mail clients POST to (RFC 8058). */
export function oneClickUrl(origin: string, uid: string, category: PrefCategory): string {
  return `${origin.replace(/\/+$/, "")}/api/comms/unsubscribe?t=${encodeURIComponent(unsubscribeToken(uid, category))}`;
}
