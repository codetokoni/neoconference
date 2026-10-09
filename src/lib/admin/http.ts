// src/lib/admin/http.ts — small helpers shared by the /api/admin routes.

import { NextResponse } from "next/server";
import type { AdminPermission } from "@/lib/admin/catalog";

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

export function fail(error: string, message: string, status = 400, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error, message, ...extra }, { status });
}

export function str(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * The permissions in `perms` the actor does not hold. Nobody but the owner
 * can hand out — or take from someone — a power they do not have.
 */
export function beyondActor(actor: { isOwner: boolean; permissions: AdminPermission[] }, perms: AdminPermission[]): AdminPermission[] {
  if (actor.isOwner) return [];
  return perms.filter((p) => !actor.permissions.includes(p));
}
