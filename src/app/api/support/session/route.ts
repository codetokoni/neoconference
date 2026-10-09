// GET /api/support/session — what the contact form needs before it is shown:
// whether the visitor is signed in (and as whom), a form token for the
// signed-out bot check (src/lib/support/formToken.ts), and the attachment
// limits. Public: people who cannot sign in must still be able to write in.

import { NextResponse } from "next/server";
import { supportCaller } from "@/lib/support/caller";
import { issueFormToken } from "@/lib/support/formToken";
import { SUPPORT_UPLOAD_ALLOWED, SUPPORT_UPLOAD_MAX_BYTES, attachmentStorageReady } from "@/lib/support/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const who = await supportCaller();
  return NextResponse.json(
    {
      signedIn: !!who,
      email: who?.email ?? null,
      name: who?.name ?? null,
      token: issueFormToken(),
      attachments: {
        allowed: !!who && attachmentStorageReady(),
        maxBytes: SUPPORT_UPLOAD_MAX_BYTES,
        types: [...SUPPORT_UPLOAD_ALLOWED],
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
