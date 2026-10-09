// src/lib/platform/gate.ts
//
// What the middleware asks before anything else: is the platform in
// maintenance, and does this (new) account pass the registration rules?
//
// Cost when nothing is switched on: one cached settings read (CACHE_MS in
// settings.ts) and no Clerk call. Only when maintenance is on, or a
// registration rule is in force, does it look at who is asking — and that
// answer is cached per account for ACCOUNT_CACHE_MS.
//
// Who always gets through maintenance:
//   - everyone, on the paths in model.ts MAINTENANCE_OPEN: /admin and
//     /api/admin (so maintenance can always be turned off again), sign-in,
//     health and version checks, cron, inbound webhooks;
//   - the owner (a verified PLATFORM_OWNER_EMAILS address — from the
//     environment, nothing in KV can take it away) and active administrators,
//     on every path.
// A failure to read the settings means maintenance is off (settings.ts), so
// a broken store cannot shut anyone out.
//
// Edge-safe: KV and Clerk's backend client only.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { kv } from "@/lib/kv";
import { isOwnerEmailList, verifiedEmails, type ClerkEmailish } from "@/lib/admin/owner";
import { getMember } from "@/lib/admin/store";
import {
  DEFAULT_PLATFORM_NAME,
  decideRegistration,
  escapeHtml,
  maintenanceActive,
  maintenanceExemptPath,
  registrationExemptPath,
  registrationRulesActive,
  type AccountFacts,
  type Maintenance,
} from "@/lib/platform/model";
import { getFeatureControls, getPlatformSettings } from "@/lib/platform/settings";

export const ACCOUNT_CACHE_MS = 60_000;
const passedKey = (userId: string) => `neo:reg:ok:${userId}`;

type Account = { staff: boolean; facts: AccountFacts | null };
const accounts = new Map<string, { value: Account; at: number }>();
const passed = new Set<string>();

export function clearGateCache(): void {
  accounts.clear();
  passed.clear();
}

function legacyAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Staff (the owner or an active administrator) and the facts the
 * registration rules judge. Mirrors src/lib/admin/context.ts resolveAdmin:
 * owner first; then the administrator record; an ADMIN_EMAILS / Clerk-role
 * admin without a record counts until the admin area adopts them.
 */
async function account(userId: string): Promise<Account> {
  const hit = accounts.get(userId);
  if (hit && Date.now() - hit.at < ACCOUNT_CACHE_MS) return hit.value;
  let value: Account;
  try {
    const user = await (await clerkClient()).users.getUser(userId);
    const emails = (user.emailAddresses ?? []) as ClerkEmailish[];
    const verified = verifiedEmails(emails);
    const primary =
      (user as { primaryEmailAddress?: { emailAddress?: string } | null }).primaryEmailAddress?.emailAddress?.toLowerCase() ||
      verified[0] ||
      emails[0]?.emailAddress?.toLowerCase() ||
      "";
    let staff = isOwnerEmailList(emails);
    if (!staff) {
      const member = await getMember(userId).catch(() => null);
      if (member) staff = member.status === "active";
      else {
        const role = (user.publicMetadata as { role?: unknown } | null)?.role;
        staff = verified.some((e) => legacyAdminEmails().includes(e)) || role === "admin";
      }
    }
    value = {
      staff,
      facts: { createdAt: Number((user as { createdAt?: number }).createdAt ?? 0), email: primary, hasVerifiedEmail: verified.length > 0 },
    };
  } catch (err) {
    console.error("[platform-gate] account lookup failed", err);
    // Not cached: the next request tries again.
    return { staff: false, facts: null };
  }
  accounts.set(userId, { value, at: Date.now() });
  return value;
}

function isApi(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/trpc");
}

export function maintenanceResponse(pathname: string, m: Maintenance, platformName: string): Response {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (m.endsAt) headers["retry-after"] = String(Math.max(60, Math.ceil((m.endsAt - Date.now()) / 1000)));
  if (isApi(pathname)) {
    return NextResponse.json({ error: "maintenance", message: m.message, endsAt: m.endsAt }, { status: 503, headers });
  }
  const name = escapeHtml(platformName || DEFAULT_PLATFORM_NAME);
  const until = m.endsAt
    ? `<p class="u">Expected back by <time datetime="${new Date(m.endsAt).toISOString()}">${escapeHtml(new Date(m.endsAt).toUTCString().replace("GMT", "UTC"))}</time></p>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${name} — down for maintenance</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#040810;color:#cffafe;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}main{max-width:520px;text-align:center}h1{font-size:26px;margin:0 0 12px;color:#fff}p{line-height:1.6;color:#a5f3fc}.u{font-size:14px;color:#67e8f9}a{color:#67e8f9}.s{margin-top:28px;font-size:12px;color:#5b7f8a}</style></head><body><main role="main" data-maintenance="on"><p style="font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#67e8f9">${name}</p><h1>Down for maintenance</h1><p>${escapeHtml(m.message)}</p>${until}<p class="s">Administrators can still <a href="/sign-in">sign in</a> and use <a href="/admin">the admin area</a>.</p></main><script>document.querySelectorAll("time[datetime]").forEach(function(t){try{t.textContent=new Date(t.getAttribute("datetime")).toLocaleString()}catch(e){}})</script></body></html>`;
  return new NextResponse(html, { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}

function registrationResponse(pathname: string, reason: string, message: string, origin: string): Response {
  if (isApi(pathname)) return NextResponse.json({ error: "registration_blocked", reason, message }, { status: 403 });
  const url = new URL("/access-blocked", origin);
  url.searchParams.set("reason", reason);
  return NextResponse.redirect(url);
}

/**
 * The middleware's first step. `userIdOf` is asked only when a rule needs
 * to know who is calling. Returns the response to send, or null to carry on.
 */
export async function platformGate(req: { url: string; nextUrl: { pathname: string } }, userIdOf: () => Promise<string | null>): Promise<Response | null> {
  const pathname = req.nextUrl.pathname;
  const [controls, settings] = await Promise.all([getFeatureControls(), getPlatformSettings()]);
  const maintenance = maintenanceActive(controls.maintenance) && !maintenanceExemptPath(pathname);
  const registration = registrationRulesActive(settings.registration) && !registrationExemptPath(pathname);
  if (!maintenance && !registration) return null;

  let userId: string | null = null;
  try {
    userId = await userIdOf();
  } catch {
    userId = null;
  }

  if (maintenance) {
    const staff = userId ? (await account(userId)).staff : false;
    if (!staff) return maintenanceResponse(pathname, controls.maintenance, settings.branding.platformName);
  }

  if (registration && userId && !passed.has(userId)) {
    // An account that passed once has passed: the rules are for sign-up.
    let ok = false;
    try {
      ok = !!(await kv.get(passedKey(userId)));
    } catch {
      ok = true; // the store is down: do not shut accounts out over it
    }
    if (!ok) {
      const a = await account(userId);
      if (!a.facts) return null; // Clerk is down: fail open
      const d = a.staff ? ({ ok: true } as const) : decideRegistration(settings.registration, a.facts);
      if (!d.ok) return registrationResponse(pathname, d.reason, d.message, req.url);
      await kv.set(passedKey(userId), 1).catch(() => undefined);
    }
    passed.add(userId);
  }
  return null;
}
