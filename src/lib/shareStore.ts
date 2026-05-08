// src/lib/shareStore.ts
// Vercel KV-backed store for recording share tokens.
// Each token unlocks a short-lived signed download URL for one R2 object key.
// Keys:
//   neo:share:<token>  -> { key, ownerUserId, label, createdAt, expiresAt }

import { kv } from "@vercel/kv";
import crypto from "node:crypto";

export type ShareRecord = {
  token: string;
  key: string;
  ownerUserId: string;
  label?: string;
  createdAt: number;
  expiresAt: number;
};

function isKvConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
  );
}

function newToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export const shareStore = {
  isConfigured: isKvConfigured,
  newToken,

  async create(input: {
    key: string;
    ownerUserId: string;
    label?: string;
    ttlSeconds?: number;
  }): Promise<ShareRecord> {
    if (!isKvConfigured()) {
      throw new Error("kv_not_configured");
    }
    const ttl = Math.max(60, Math.min(input.ttlSeconds ?? 7 * 24 * 3600, 30 * 24 * 3600));
    const now = Date.now();
    const rec: ShareRecord = {
      token: newToken(),
      key: input.key,
      ownerUserId: input.ownerUserId,
      label: input.label,
      createdAt: now,
      expiresAt: now + ttl * 1000,
    };
    await kv.set(`neo:share:${rec.token}`, JSON.stringify(rec), { ex: ttl });
    return rec;
  },

  async get(token: string): Promise<ShareRecord | null> {
    if (!isKvConfigured()) return null;
    const raw = await kv.get<string>(`neo:share:${token}`);
    if (!raw) return null;
    try {
      const rec = (typeof raw === "string" ? JSON.parse(raw) : raw) as ShareRecord;
      if (rec.expiresAt && rec.expiresAt < Date.now()) return null;
      return rec;
    } catch {
      return null;
    }
  },

  async revoke(token: string): Promise<void> {
    if (!isKvConfigured()) return;
    await kv.del(`neo:share:${token}`);
  },
};

