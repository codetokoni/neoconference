// GET /api/support/session — what the contact form needs before it is shown:
// whether the visitor is signed in (and as whom), a form token for the
// signed-out bot check (src/lib/support/formToken.ts), and the attachment
// limits. Public: people who cannot sign in must still be able to write in.

import { NextResponse } from "next/server";
import { supportCaller } from "@/lib/support/caller";
import { issueFormToken } from "@/lib/support/formToken";
import { attachmentStorageReady } from "@/lib/support/tickets";
import { uploadRule } from "@/lib/content/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const who = await supportCaller();
  // Set in the admin area (Content > Limits); the form refuses big files before sending.
  const rule = await uploadRule("support");
  return NextResponse.json(
    {
      signedIn: !!who,
      email: who?.email ?? null,
      name: who?.name ?? null,
      token: issueFormToken(),
      attachments: {
        allowed: !!who && attachmentStorageReady(),
        maxBytes: rule.maxBytes,
        types: rule.mimes,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
