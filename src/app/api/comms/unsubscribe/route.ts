// /api/comms/unsubscribe — stop one category of optional email, signed out.
//
// Public in middleware: the signed token in ?t= is the credential (it names
// one account and one category; src/lib/comms/prefs.ts).
//
// GET   sends the browser to the /unsubscribe page, which asks first: link
//       scanners in mail systems open every link, and must not unsubscribe
//       anyone by doing so.
// POST  unsubscribes. Mail clients' one-click button posts
//       "List-Unsubscribe=One-Click" here (RFC 8058) and gets 200; the
//       /unsubscribe page's form posts action=unsubscribe|resubscribe and
//       is sent back to the page.

import { NextResponse } from "next/server";
import { readUnsubscribeToken, updatePrefs } from "@/lib/comms/prefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  return NextResponse.redirect(new URL(`/unsubscribe?t=${encodeURIComponent(url.searchParams.get("t") ?? "")}`, url.origin), 303);
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  let form: URLSearchParams | null = null;
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data") || type.includes("text/plain")) {
    form = new URLSearchParams(await req.text().catch(() => ""));
  }
  const token = form?.get("t") || url.searchParams.get("t");
  const who = readUnsubscribeToken(token);
  const fromPage = form?.get("from") === "page";
  if (!who) {
    if (fromPage) return NextResponse.redirect(new URL(`/unsubscribe?t=${encodeURIComponent(token ?? "")}`, url.origin), 303);
    return NextResponse.json({ error: "invalid_token", message: "This unsubscribe link is not valid." }, { status: 400 });
  }
  const resubscribe = form?.get("action") === "resubscribe";
  await updatePrefs(who.uid, { [who.category]: { email: resubscribe } }, "unsubscribe_link");
  if (fromPage) {
    return NextResponse.redirect(new URL(`/unsubscribe?t=${encodeURIComponent(token!)}&done=${resubscribe ? "resubscribed" : "unsubscribed"}`, url.origin), 303);
  }
  return NextResponse.json({ ok: true, category: who.category, email: resubscribe });
}
