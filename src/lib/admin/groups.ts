// src/lib/admin/groups.ts — groups as the admin area sees them: every
// group (from the index in groupStore), its owner and its numbers.

import { clerkClient } from "@clerk/nextjs/server";
import {
  backfillGroupIndex,
  countMembers,
  countPending,
  getGroup,
  groupIndexBackfilledAt,
  listAllGroupIds,
  listMembers,
  type Group,
} from "@/lib/groupStore";
import { isOwnerUser, type ClerkUserish } from "@/lib/admin/users";

export interface GroupRow {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  memberCount: number;
  pendingCount: number;
}

export async function groupRow(group: Group): Promise<GroupRow> {
  const [members, pendingCount] = await Promise.all([listMembers(group.id), countPending(group.id)]);
  const owner = members.find((m) => m.role === "owner") ?? null;
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    createdAt: group.createdAt,
    ownerId: owner?.userId ?? null,
    ownerName: owner?.name ?? null,
    ownerEmail: owner?.email ?? null,
    memberCount: members.length || (await countMembers(group.id)),
    pendingCount,
  };
}

/**
 * Every group, newest first. The first time (no backfill recorded), the
 * index is rebuilt from the per-user sets so groups created before it
 * existed are listed too.
 */
export async function listAllGroups(): Promise<{ groups: GroupRow[]; backfilledAt: number | null; backfilled: boolean }> {
  let backfilled = false;
  if ((await groupIndexBackfilledAt()) == null) {
    await backfillGroupIndex();
    backfilled = true;
  }
  const ids = await listAllGroupIds();
  const groups = (await Promise.all(ids.map((id) => getGroup(id)))).filter((g): g is Group => !!g);
  const rows = await Promise.all(groups.map(groupRow));
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { groups: rows, backfilledAt: await groupIndexBackfilledAt(), backfilled };
}

/** Whether a member's account is the platform owner's. A deleted account is not. */
export async function isPlatformOwnerId(userId: string): Promise<boolean> {
  try {
    const client = await clerkClient();
    return isOwnerUser((await client.users.getUser(userId)) as unknown as ClerkUserish);
  } catch {
    return false;
  }
}
