// /api/admin/comms/sends/[id]/process — deliver the next slice now (notifications:send).
//
// POST   The send page calls this while it is open, so a send moves along
//        at once instead of waiting for the scheduler. Safe to repeat: one
//        worker at a time, and nobody is sent anything twice.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { fail } from "@/lib/admin/http";
import { getSend, processSend } from "@/lib/comms/sends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const send = await getSend(params.id);
  if (!send) return fail("not_found", "That send was not found.", 404);
  if (send.status === "draft") return fail("not_confirmed", "Confirm the send first.", 409);
  const progress = await processSend(send.id, 8_000);
  return NextResponse.json({ ok: true, progress, send: await getSend(send.id) });
}
