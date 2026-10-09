// src/lib/content/limits.ts
//
// Upload limits an administrator sets (/admin/content/limits), and the one
// call every upload route makes before it stores anything:
//
//   const refused = await refuseUpload("chat", file);
//   if (refused) return refused;
//
//   neo:content:limits   JSON { rules: { [kind]: UploadRule }, updatedAt, updatedById, updatedByEmail }
//
// A kind with nothing saved uses DEFAULT_UPLOAD_RULES (what the routes
// accepted before). If KV cannot be read the defaults apply: an outage must
// not stop people attaching files, and must not lift the limits either.

import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { getPlanLimitsForUserId } from "@/lib/plan";
import { allFiles } from "@/lib/content/files";
import {
  DEFAULT_UPLOAD_RULES,
  UPLOAD_KINDS,
  checkUpload,
  formatBytes,
  cleanRule,
  type UploadKind,
  type UploadRule,
} from "@/lib/content/model";

const KEY = "neo:content:limits";

export interface SavedLimits {
  rules: Partial<Record<UploadKind, UploadRule>>;
  updatedAt?: number;
  updatedById?: string;
  updatedByEmail?: string;
}

function parse(raw: unknown): SavedLimits | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as SavedLimits;
  try {
    return JSON.parse(String(raw)) as SavedLimits;
  } catch {
    return null;
  }
}

export async function savedLimits(): Promise<SavedLimits> {
  return parse(await kv.get(KEY)) ?? { rules: {} };
}

/** Every kind's rule in force: saved where valid, the default otherwise. */
export async function uploadRules(): Promise<Record<UploadKind, UploadRule>> {
  let saved: SavedLimits = { rules: {} };
  try {
    saved = await savedLimits();
  } catch (err) {
    console.warn("[content-limits] read failed; using the defaults", err);
  }
  const out = { ...DEFAULT_UPLOAD_RULES };
  for (const k of UPLOAD_KINDS) {
    const r = saved.rules?.[k.id];
    if (!r) continue;
    const clean = cleanRule(r);
    if (!("error" in clean)) out[k.id] = clean;
  }
  return out;
}

export async function uploadRule(kind: UploadKind): Promise<UploadRule> {
  return (await uploadRules())[kind];
}

export async function saveUploadRules(
  rules: Partial<Record<UploadKind, UploadRule>>,
  by: { userId: string; email: string },
): Promise<SavedLimits> {
  const next: SavedLimits = { rules, updatedAt: Date.now(), updatedById: by.userId, updatedByEmail: by.email };
  await kv.set(KEY, JSON.stringify(next));
  return next;
}

/**
 * The server-side check for an upload route: null when the file may be
 * stored, else the response to send. The message is written for the person
 * uploading; `error` keeps the codes the apps already read.
 */
export async function refuseUpload(
  kind: UploadKind,
  file: { size: number; type?: string; name?: string },
  /** Whose storage the file counts against, for the plan quota. */
  ownerId?: string,
): Promise<NextResponse | null> {
  const refusal = checkUpload(await uploadRule(kind), file);
  if (refusal) {
    const { status, ...body } = refusal;
    return NextResponse.json({ ok: false, ...body }, { status });
  }
  return ownerId ? refuseOverQuota(ownerId, file.size) : null;
}

/**
 * The plan's storage quota (phase 3: limits.storageGb, 0 = unlimited)
 * against what the owner already stores, files in the trash not counted.
 * Null when the file fits. Fails open: a lookup that breaks never blocks
 * an upload.
 */
export async function refuseOverQuota(ownerId: string, addBytes: number): Promise<NextResponse | null> {
  if (!ownerId) return null;
  try {
    const { limits } = await getPlanLimitsForUserId(ownerId);
    const gb = Number(limits.storageGb) || 0;
    if (gb <= 0) return null;
    const quota = gb * 1024 * 1024 * 1024;
    const used = (await allFiles()).filter((r) => r.ownerId === ownerId && r.state !== "trashed").reduce((s, r) => s + r.size, 0);
    if (used + addBytes <= quota) return null;
    return NextResponse.json(
      {
        ok: false,
        error: "storage_full",
        message: `Your plan's storage (${gb} GB) is full: ${formatBytes(used)} is in use. Delete files you no longer need, or see the plans at neoconference.app/pricing.`,
        quota,
        used,
      },
      { status: 413 },
    );
  } catch (err) {
    console.warn("[content-limits] quota check failed; allowing the upload", err);
    return null;
  }
}
