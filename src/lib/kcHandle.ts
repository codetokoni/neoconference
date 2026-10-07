// src/lib/kcHandle.ts
//
// KingsChat handles: cleaning what someone typed, and finding the account
// that signed in with one. Server-only (Clerk backend API).
//
// The same lookup lives inline in /api/events/[id]/invite-kc and
// /api/kc/send; this is the shared copy groups use.

import { clerkClient } from "@clerk/nextjs/server";
import { findClerkIdByKcHandle, indexKcHandle } from "@/lib/kc-tokens";

/**
 * A handle as typed ("@Ada", "kc:ada", " ada ") in its stored form ("ada"),
 * or null when there is nothing usable. Same rules as invite-kc.
 */
export function normalizeKcHandle(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const stripped = s.startsWith("@") ? s.slice(1) : s.toLowerCase().startsWith("kc:") ? s.slice(3) : s;
  const handle = stripped.trim().toLowerCase();
  if (!handle || handle.length > 64 || /[\s@/]/.test(handle)) return null;
  return handle;
}

/**
 * The Clerk users who signed in with these KingsChat handles (normalized), by
 * handle; handles nobody has signed in with are absent. The index the KC
 * sign-in writes answers at once; for accounts that signed in before it
 * existed, one scan of Clerk users finds them all and fills the index in.
 */
export async function clerkIdsForKcHandles(handles: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const unknown = new Set<string>();
  for (const h of new Set(handles)) {
    const cached = await findClerkIdByKcHandle(h);
    if (cached) found.set(h, cached);
    else unknown.add(h);
  }
  if (unknown.size === 0) return found;
  try {
    const cc = await clerkClient();
    const list = await cc.users.getUserList({ limit: 500 });
    for (const u of list.data) {
      const name = (u.publicMetadata as { kingschat?: { username?: string } } | undefined)?.kingschat?.username;
      const h = name?.toLowerCase();
      if (h && unknown.has(h)) {
        found.set(h, u.id);
        unknown.delete(h);
        await indexKcHandle(h, u.id).catch(() => {});
      }
    }
  } catch (err) {
    console.warn("[kcHandle] clerk lookup failed", err);
  }
  return found;
}
