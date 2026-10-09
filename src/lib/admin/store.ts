// src/lib/admin/store.ts
//
// Administrators and administrator roles, in KV so they hold across devices
// and deploys:
//
//   neo:admin:roles    hash  roleId -> AdminRole JSON   (custom roles only)
//   neo:admin:members  hash  userId -> AdminMember JSON
//
// Built-in roles live in catalog.ts and are never written here. The owner is
// never a member record (see owner.ts).

import { kv } from "@/lib/kv";
import {
  BUILT_IN_ROLES,
  builtInRole,
  isAdminPermission,
  type AdminPermission,
  type AdminRole,
} from "@/lib/admin/catalog";

const ROLES = "neo:admin:roles";
const MEMBERS = "neo:admin:members";

/** "removed" is kept, not deleted, so an ADMIN_EMAILS admin who was removed is not adopted again. */
export type AdminStatus = "active" | "suspended" | "removed";

export interface AdminMember {
  userId: string;
  email: string;
  name: string;
  roleId: string;
  status: AdminStatus;
  /** userId of whoever appointed them, or "legacy" for an admin from before roles existed. */
  appointedBy: string;
  appointedAt: number;
  updatedAt: number;
  suspendedReason?: string;
  suspendedAt?: number;
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

/* --------------------------------- roles --------------------------------- */

export async function listRoles(): Promise<AdminRole[]> {
  const all = ((await kv.hgetall(ROLES)) ?? {}) as Record<string, unknown>;
  const custom = Object.values(all)
    .map((v) => parse<AdminRole>(v))
    .filter((r): r is AdminRole => !!r)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...BUILT_IN_ROLES, ...custom];
}

export async function getRole(id: string): Promise<AdminRole | null> {
  const builtIn = builtInRole(id);
  if (builtIn) return builtIn;
  return parse<AdminRole>(await kv.hget(ROLES, id));
}

export function cleanPermissions(input: unknown): AdminPermission[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter(isAdminPermission))];
}

export async function saveRole(role: AdminRole): Promise<void> {
  if (builtInRole(role.id)) throw new Error("built-in roles cannot be changed");
  await kv.hset(ROLES, { [role.id]: JSON.stringify({ ...role, builtIn: false }) });
}

export async function deleteRole(id: string): Promise<void> {
  await kv.hdel(ROLES, id);
}

export function newRoleId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return `custom_${slug || "role"}_${Math.random().toString(36).slice(2, 7)}`;
}

/* -------------------------------- members -------------------------------- */

export async function listMembers(): Promise<AdminMember[]> {
  const all = ((await kv.hgetall(MEMBERS)) ?? {}) as Record<string, unknown>;
  return Object.values(all)
    .map((v) => parse<AdminMember>(v))
    .filter((m): m is AdminMember => !!m)
    .sort((a, b) => a.appointedAt - b.appointedAt);
}

export async function getMember(userId: string): Promise<AdminMember | null> {
  if (!userId) return null;
  return parse<AdminMember>(await kv.hget(MEMBERS, userId));
}

export async function saveMember(m: AdminMember): Promise<void> {
  await kv.hset(MEMBERS, { [m.userId]: JSON.stringify(m) });
}

export async function removeMember(userId: string): Promise<void> {
  await kv.hdel(MEMBERS, userId);
}

export async function membersWithRole(roleId: string): Promise<AdminMember[]> {
  return (await listMembers()).filter((m) => m.roleId === roleId);
}
