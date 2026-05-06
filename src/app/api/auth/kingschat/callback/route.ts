import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { clerkClient } from "@clerk/nextjs/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KC_TOKEN_URL = "https://connect.kingsch.at/developer/oauth2/token";
const KC_PROFILE_URL = "https://connect.kingsch.at/developer/api/profile";

function stateSecret(): Uint8Array {
  const s = process.env.KINGSCHAT_STATE_SECRET;
  if (!s) throw new Error("KINGSCHAT_STATE_SECRET not configured");
  return new TextEncoder().encode(s);
}

type KCToken = {
  access_token: string;
  refresh_token: string;
  expires_in_millis: number;
};
type KCProfile = {
  profile: {
    id: string;
    email?: string;
    name?: string;
    username?: string;
    avatar?: string;
  };
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) return errorRedirect(req, `kc_error_${errorParam}`);
  if (!code || !state) return errorRedirect(req, "missing_code_or_state");

  try {
    await jwtVerify(state, stateSecret());
  } catch {
    return errorRedirect(req, "invalid_state");
  }

  const clientId = process.env.KINGSCHAT_CLIENT_ID;
  if (!clientId) return errorRedirect(req, "no_client_id");

  let token: KCToken;
  try {
    const r = await fetch(KC_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "code",
        client_id: clientId,
        code,
      }),
      cache: "no-store",
    });
    if (!r.ok) return errorRedirect(req, `token_${r.status}`);
    token = (await r.json()) as KCToken;
  } catch {
    return errorRedirect(req, "token_fetch_failed");
  }

  let prof: KCProfile["profile"];
  try {
    const r = await fetch(KC_PROFILE_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
      cache: "no-store",
    });
    if (!r.ok) return errorRedirect(req, `profile_${r.status}`);
    const json = (await r.json()) as KCProfile;
    prof = json.profile;
  } catch {
    return errorRedirect(req, "profile_fetch_failed");
  }
  if (!prof?.id) return errorRedirect(req, "no_profile_id");

  const externalId = `kc:${prof.id}`;
  const cc = await clerkClient();

  let userId: string | null = null;
  try {
    const byExt = await cc.users.getUserList({ externalId: [externalId] });
    if (byExt.totalCount > 0) {
      userId = byExt.data[0].id;
    } else if (prof.email) {
      const byEmail = await cc.users.getUserList({
        emailAddress: [prof.email],
      });
      if (byEmail.totalCount > 0) {
        return errorRedirect(req, "email_already_registered");
      }
    }
  } catch {
    return errorRedirect(req, "lookup_failed");
  }

  const tokenMeta = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + token.expires_in_millis,
  };

  if (!userId) {
    try {
      const created = await cc.users.createUser({
        externalId,
        emailAddress: prof.email ? [prof.email] : undefined,
        firstName: prof.name?.split(" ")[0],
        lastName:
          prof.name?.split(" ").slice(1).join(" ") || undefined,
        username: prof.username,
        skipPasswordRequirement: true,
        publicMetadata: {
          kingschat: { id: prof.id, username: prof.username },
        },
        privateMetadata: { kingschat_tokens: tokenMeta },
      } as any);
      userId = created.id;
    } catch {
      return errorRedirect(req, "create_failed");
    }
  } else {
    try {
      await cc.users.updateUserMetadata(userId, {
        privateMetadata: { kingschat_tokens: tokenMeta },
      });
    } catch {
      /* non-fatal */
    }
  }

  let ticket: string;
  try {
    const t = await (cc as any).signInTokens.createSignInToken({
      userId,
      expiresInSeconds: 60,
    });
    ticket = t.token;
  } catch {
    return errorRedirect(req, "ticket_failed");
  }

  const dest = new URL("/sign-in", req.url);
  dest.searchParams.set("__clerk_ticket", ticket);
  return NextResponse.redirect(dest);
}

function errorRedirect(req: NextRequest, code: string) {
  const dest = new URL("/sign-in", req.url);
  dest.searchParams.set("kc_error", code);
  return NextResponse.redirect(dest);
}
