// /api/admin/comms/sends/[id]/recipients — per-recipient status (notifications:send).
//
// GET ?chunk=<n>   one block of up to 100 recipients with each channel's
//                  state (sent, failed, skipped, delivered, bounced, …)

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { fail } from "@/lib/admin/http";
import { chunkStatuses, getSend } from "@/lib/comms/sends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const send = await getSend(params.id);
  if (!send) return fail("not_found", "That send was not found.", 404);
  const raw = Number(new URL(req.url).searchParams.get("chunk") ?? 0);
  const chunk = Number.isInteger(raw) && raw >= 0 && raw < send.chunks ? raw : 0;
  const items = send.chunks ? await chunkStatuses(send.id, chunk) : [];
  return NextResponse.json({ chunk, chunks: send.chunks, items }, { headers: { "cache-control": "no-store" } });
}
