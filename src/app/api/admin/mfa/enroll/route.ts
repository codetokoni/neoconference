// POST /api/admin/mfa/enroll — start setting up the authenticator app.
// Returns the secret (shown once, for manual entry) and a QR code. Nothing
// is active until /api/admin/mfa/confirm receives a code from the app.

import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { requireAdmin } from "@/lib/admin/context";
import { startEnrollment } from "@/lib/admin/mfa";
import { fail } from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await requireAdmin(req, null, { allowWithoutMfa: true });
  if (!g.ok) return g.response;
  if (g.ctx.mfa.enrolled) {
    return fail("already_enrolled", "Two-factor is already set up. Use a recovery code if you lost your authenticator.", 409);
  }
  const { secret, otpauthUrl } = await startEnrollment(g.ctx.userId, g.ctx.email);
  const qr = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
  return NextResponse.json({ ok: true, secret, otpauthUrl, qr });
}
