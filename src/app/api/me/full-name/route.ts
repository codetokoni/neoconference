// /api/me/full-name — the signed-in person's full name, as meeting reports
// show it (src/lib/attendeeName.ts).
//
// GET   { fullName, needed }   needed: a KingsChat account with no name from
//                              KingsChat and none saved, asked before joining
// POST  { fullName }           saves it as the account's first and last name,
//                              once, so every later sign-in and report has it
//
// Only ever the caller's own account.

import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { accountFullName, cleanFullName, fullNameProblem, needsFullName, splitFullName } from "@/lib/attendeeName";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cc = await clerkClient();
  const user = await cc.users.getUser(userId);
  return NextResponse.json(
    { fullName: accountFullName(user), needed: needsFullName(user) },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { fullName?: unknown } | null;
  const problem = fullNameProblem(body?.fullName);
  if (problem) return NextResponse.json({ error: "invalid_name", message: problem }, { status: 400 });

  const name = cleanFullName(body!.fullName);
  const cc = await clerkClient();
  try {
    const user = await cc.users.updateUser(userId, splitFullName(name));
    return NextResponse.json({ ok: true, fullName: accountFullName(user), needed: needsFullName(user) });
  } catch (err) {
    console.error("[me/full-name] could not save the name", err);
    return NextResponse.json({ error: "save_failed", message: "Your name could not be saved. Try again." }, { status: 502 });
  }
}
