// GET /download — neoconference.app/download: the NeoConference page on the
// LoveWorld AppStore, where the app is downloaded and updated (and where the
// owner wants every download counted). A short address people can type: an
// old app's "please update" message is plain text, and the store's own link
// (share/lW-APP-Y26-XG9328) is hard to copy by hand.

import { NextResponse } from "next/server";
import { APP_STORE_URL } from "@/lib/appGate";

export const dynamic = "force-static";

export function GET() {
  return NextResponse.redirect(APP_STORE_URL, 302);
}
