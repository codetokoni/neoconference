// POST /api/partner/embed/handoff — "Open in new tab". The embed page
// trades its session for a one-time code (one minute) that only this
// site's own page can redeem; it passes the code to the new tab by
// postMessage, never in the address. Same person, same meeting, same
// participant role.

import { NextRequest } from "next/server";
import { issueCode, verifySession } from "@/lib/partners/store";
import { fail, ipOf, limit, ok, readJson } from "@/lib/partners/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await limit(`handoff:${ipOf(req)}`, 30);
    const body = await readJson(req);
    const grant = verifySession(body.session);
    const { code, expiresAt } = await issueCode({ ...grant, origin: "self" }, 60);
    return ok({ code, expiresAt });
  } catch (e) {
    return fail(e);
  }
}
