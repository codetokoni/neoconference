// GET /api/admin/api-keys (integrations:write, no fresh code to look)
// Every developer API key on the platform — masked (nc_live_...abcd), never
// the key or its hash — with the account it belongs to.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAdmin } from "@/lib/admin/context";
import { listAllApiKeys } from "@/lib/platform/apiKeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "integrations:write", { readOnly: true });
  if (!g.ok) return g.response;
  const keys = await listAllApiKeys();
  const owners = [...new Set(keys.map((k) => k.ownerUserId).filter((x): x is string => !!x))].slice(0, 200);
  const emails = new Map<string, string>();
  const client = await clerkClient();
  await Promise.all(
    owners.map(async (id) => {
      try {
        const u = await client.users.getUser(id);
        emails.set(id, u.emailAddresses?.[0]?.emailAddress ?? "");
      } catch {
        /* account gone: shown by id */
      }
    }),
  );
  return NextResponse.json({
    ok: true,
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      maskedKey: k.maskedKey,
      plan: k.plan,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revoked: k.revoked,
      revokedAt: k.revokedAt ?? null,
      rotatedFrom: k.rotatedFrom ?? null,
      ownerUserId: k.ownerUserId,
      ownerEmail: k.ownerUserId ? (emails.get(k.ownerUserId) ?? null) : null,
    })),
  });
}
