import { NextRequest, NextResponse } from "next/server";
import { SignJWT } from "jose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KC_AUTH_URL = "https://accounts.kingsch.at/";

function stateSecret(): Uint8Array {
  const s = process.env.KINGSCHAT_STATE_SECRET;
  if (!s) throw new Error("KINGSCHAT_STATE_SECRET not configured");
  return new TextEncoder().encode(s);
}

export async function GET(req: NextRequest) {
  const clientId = process.env.KINGSCHAT_CLIENT_ID;
  const redirectUri =
    process.env.KINGSCHAT_REDIRECT_URI ||
    `${new URL(req.url).origin}/api/auth/kingschat/callback`;
  if (!clientId) {
    return NextResponse.json(
      { error: "KINGSCHAT_CLIENT_ID not set" },
      { status: 500 }
    );
  }
  const nonce = crypto.randomUUID();
  const state = await new SignJWT({ nonce })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .sign(stateSecret());

  const url = new URL(KC_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scopes", JSON.stringify(["send_chat_message"]));
  return NextResponse.redirect(url.toString());
}
