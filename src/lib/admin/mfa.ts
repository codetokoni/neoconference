// src/lib/admin/mfa.ts
//
// Two-factor authentication for administrators, independent of Clerk:
// production Clerk has its authenticator-app and backup-code factors off, so
// this is the second factor for the admin area. Standard TOTP (RFC 6238:
// SHA-1, 6 digits, 30 s), which every authenticator app reads.
//
//   neo:admin:mfa:<uid>          MfaRecord (secret AES-256-GCM encrypted,
//                                recovery codes hashed, last step used)
//   neo:admin:mfa:pending:<uid>  enrollment in progress (15 min)
//   neo:admin:mfa:fail:<uid>     wrong-code counter (15 min window)
//
// A correct code gives an admin session: an HMAC-signed, httpOnly cookie
// bound to the user AND their Clerk session, valid 12 hours. Sensitive
// actions also need the code to have been entered in the last 10 minutes
// (step-up). Keys derive from ADMIN_MFA_KEY, else CLERK_SECRET_KEY.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { kv } from "@/lib/kv";

export const ADMIN_SESSION_COOKIE = "neo_admin_mfa";
export const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
export const STEP_UP_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_S = 15 * 60;
const ISSUER = "NeoConference Admin";

const recKey = (uid: string) => `neo:admin:mfa:${uid}`;
const pendingKey = (uid: string) => `neo:admin:mfa:pending:${uid}`;
const failKey = (uid: string) => `neo:admin:mfa:fail:${uid}`;

function rootSecret(): string {
  const s = process.env.ADMIN_MFA_KEY || process.env.CLERK_SECRET_KEY;
  if (!s) throw new Error("ADMIN_MFA_KEY or CLERK_SECRET_KEY must be set for admin two-factor");
  return s;
}

function derive(label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", rootSecret(), "neo-admin", label, 32));
}

/* -------------------------------- base32 -------------------------------- */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* --------------------------------- TOTP --------------------------------- */

export function totpAt(secret: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 30_000);
}

/** The step the code belongs to (±1 step of clock drift), or null. A step at or before `lastStep` is a replay. */
export function matchTotp(secret: Buffer, code: string, now = Date.now(), lastStep = -1): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const s = currentStep(now);
  for (const step of [s - 1, s, s + 1]) {
    if (step <= lastStep) continue;
    const want = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(want, Buffer.from(c))) return step;
  }
  return null;
}

/* ------------------------------ encryption ------------------------------ */

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive("mfa-secret"), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

function decrypt(enc: string): string {
  const [iv, tag, body] = enc.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", derive("mfa-secret"), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

function hashRecovery(code: string): string {
  return createHmac("sha256", derive("mfa-recovery")).update(code.trim().toLowerCase()).digest("base64url");
}

function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const s = base32Encode(randomBytes(5)).toLowerCase().slice(0, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

/* -------------------------------- records ------------------------------- */

interface MfaRecord {
  secret: string;
  enabledAt: number;
  recovery: string[];
  lastStep: number;
}

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

async function readRecord(uid: string): Promise<MfaRecord | null> {
  return parse<MfaRecord>(await kv.get(recKey(uid)));
}

export async function mfaStatus(uid: string): Promise<{ enrolled: boolean; enabledAt?: number; recoveryLeft?: number }> {
  const r = await readRecord(uid);
  return r ? { enrolled: true, enabledAt: r.enabledAt, recoveryLeft: r.recovery.length } : { enrolled: false };
}

export async function startEnrollment(uid: string, email: string): Promise<{ secret: string; otpauthUrl: string }> {
  const secret = base32Encode(randomBytes(20));
  await kv.set(pendingKey(uid), JSON.stringify({ secret: encrypt(secret) }), { ex: 900 });
  const label = encodeURIComponent(`${ISSUER}:${email}`);
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
  return { secret, otpauthUrl };
}

/** Finish enrollment with a code from the app. Returns the recovery codes (shown once), or null. */
export async function confirmEnrollment(uid: string, code: string, now = Date.now()): Promise<string[] | null> {
  const pending = parse<{ secret: string }>(await kv.get(pendingKey(uid)));
  if (!pending) return null;
  const secret = base32Decode(decrypt(pending.secret));
  const step = matchTotp(secret, code, now);
  if (step == null) return null;
  const codes = newRecoveryCodes();
  const rec: MfaRecord = { secret: pending.secret, enabledAt: now, recovery: codes.map(hashRecovery), lastStep: step };
  await kv.set(recKey(uid), JSON.stringify(rec));
  await kv.del(pendingKey(uid));
  return codes;
}

export type VerifyResult = "ok" | "recovery" | "invalid" | "locked" | "not_enrolled";

/** Check a 6-digit code or a recovery code. Wrong codes count; five in 15 minutes lock it. */
export async function verifyAdminCode(uid: string, code: string, now = Date.now()): Promise<VerifyResult> {
  const rec = await readRecord(uid);
  if (!rec) return "not_enrolled";
  const fails = Number((await kv.get(failKey(uid))) ?? 0);
  if (fails >= MAX_FAILURES) return "locked";

  const trimmed = (code ?? "").trim();
  if (/^\d{3}\s?\d{3}$/.test(trimmed)) {
    const step = matchTotp(base32Decode(decrypt(rec.secret)), trimmed, now, rec.lastStep);
    if (step != null) {
      await kv.set(recKey(uid), JSON.stringify({ ...rec, lastStep: step }));
      await kv.del(failKey(uid));
      return "ok";
    }
  } else if (trimmed) {
    const h = hashRecovery(trimmed);
    if (rec.recovery.includes(h)) {
      await kv.set(recKey(uid), JSON.stringify({ ...rec, recovery: rec.recovery.filter((x) => x !== h) }));
      await kv.del(failKey(uid));
      return "recovery";
    }
  }
  const n = Number(await kv.incr(failKey(uid)));
  if (n === 1) await kv.expire(failKey(uid), FAILURE_WINDOW_S);
  return n >= MAX_FAILURES ? "locked" : "invalid";
}

export async function regenerateRecoveryCodes(uid: string): Promise<string[] | null> {
  const rec = await readRecord(uid);
  if (!rec) return null;
  const codes = newRecoveryCodes();
  await kv.set(recKey(uid), JSON.stringify({ ...rec, recovery: codes.map(hashRecovery) }));
  return codes;
}

export async function resetMfa(uid: string): Promise<void> {
  await kv.del(recKey(uid));
  await kv.del(pendingKey(uid));
  await kv.del(failKey(uid));
}

/* ---------------------------- admin session ----------------------------- */

export interface AdminSession {
  uid: string;
  sid: string;
  iat: number;
  stepUpAt: number;
}

export function signAdminSession(s: AdminSession): string {
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  const mac = createHmac("sha256", derive("admin-session")).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** The session in the cookie, if it is genuine, unexpired and for this user and Clerk session. */
export function readAdminSession(value: string | null | undefined, uid: string, sid: string | null, now = Date.now()): AdminSession | null {
  if (!value || !sid) return null;
  const [body, mac] = value.split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", derive("admin-session")).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const s = parse<AdminSession>(Buffer.from(body, "base64url").toString("utf8"));
  if (!s || s.uid !== uid || s.sid !== sid) return null;
  if (now - s.iat > ADMIN_SESSION_MS || s.iat > now + 60_000) return null;
  return s;
}

export function cookieFrom(header: string | null | undefined, name = ADMIN_SESSION_COOKIE): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  maxAge: ADMIN_SESSION_MS / 1000,
};
