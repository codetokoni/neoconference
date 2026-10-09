// GET /api/admin/users — the Users list. users:read.
//
//   ?q=            name, email, username, user id (Clerk's own search)
//   &plan=         free | starter | pro | business | enterprise (the plan the app applies)
//   &access=       owner | admin | staff | user
//   &verified=     yes | no          (primary email)
//   &status=       active | suspended | pending_deletion
//   &tag=          an internal tag
//   &from= &to=    sign-up date, YYYY-MM-DD (inclusive): calendar days in
//   &tz=           this IANA zone (default UTC; the Overview's links set it)
//   &sort=         [-]created_at | last_sign_in_at | last_active_at | email_address | first_name
//   &page=1 &pageSize=25 (10–100)
//
// Clerk searches and sorts but cannot filter on plan, verification,
// suspension or our tags. With none of those, Clerk pages directly. With any,
// up to SCAN_CAP accounts are read in Clerk's order and filtered here; the
// answer says how many were read and whether there were more.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAdmin } from "@/lib/admin/context";
import { listMembers } from "@/lib/admin/store";
import { isPlan } from "@/lib/planLimits";
import { addDays, isDay, isTimeZone, zonedDayStart } from "@/lib/activityReports";
import { allDeletions, allTags, summarize, type ClerkUserish, type UserRow } from "@/lib/admin/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SORTS = ["created_at", "last_sign_in_at", "last_active_at", "email_address", "first_name"] as const;
const SCAN_PAGE = 500;
const SCAN_CAP = 5000;
type Sort = `${"" | "-"}${(typeof SORTS)[number]}`;

/** Midnight at the start of day `v` in `tz`, as epoch ms. */
function dayStart(v: string | null, tz: string): number | null {
  return isDay(v) ? zonedDayStart(v, tz) : null;
}

export async function GET(req: Request) {
  const g = await requireAdmin(req, "users:read");
  if (!g.ok) return g.response;

  const url = new URL(req.url);
  const p = url.searchParams;
  const q = (p.get("q") ?? p.get("query") ?? "").trim().slice(0, 100) || undefined;
  const plan = p.get("plan");
  const access = p.get("access");
  const verified = p.get("verified");
  const status = p.get("status");
  const tag = (p.get("tag") ?? "").trim().toLowerCase() || null;
  const tz = isTimeZone(p.get("tz")) ? (p.get("tz") as string) : "UTC";
  const from = dayStart(p.get("from"), tz);
  const toNext = isDay(p.get("to")) ? dayStart(addDays(p.get("to") as string, 1), tz) : null;
  const to = toNext == null ? null : toNext - 1;
  const rawSort = p.get("sort") ?? "-created_at";
  const sort: Sort = (SORTS as readonly string[]).includes(rawSort.replace(/^-/, "")) ? (rawSort as Sort) : "-created_at";
  const pageSize = Math.min(Math.max(parseInt(p.get("pageSize") ?? "25", 10) || 25, 10), 100);
  const page = Math.max(parseInt(p.get("page") ?? "1", 10) || 1, 1);

  const [memberList, tags, deletions] = await Promise.all([listMembers(), allTags(), allDeletions()]);
  const members = new Map(memberList.map((m) => [m.userId, m]));
  const row = (u: ClerkUserish) =>
    summarize(u, { member: members.get(u.id), tags: tags.get(u.id), deletion: deletions.get(u.id) ?? null });

  const client = await clerkClient();
  const filtered =
    (plan && isPlan(plan)) ||
    ["owner", "admin", "staff", "user"].includes(access ?? "") ||
    verified === "yes" ||
    verified === "no" ||
    ["active", "suspended", "pending_deletion"].includes(status ?? "") ||
    !!tag ||
    from != null ||
    to != null;

  if (!filtered) {
    const list = await client.users.getUserList({ query: q, orderBy: sort, limit: pageSize, offset: (page - 1) * pageSize });
    return NextResponse.json({
      items: (list.data as unknown as ClerkUserish[]).map(row),
      total: list.totalCount,
      page,
      pageSize,
      scanned: null,
      capped: false,
    });
  }

  const keep = (r: UserRow) => {
    if (plan && isPlan(plan) && r.plan !== plan) return false;
    if (access === "owner" && r.access !== "owner") return false;
    if (access === "admin" && !(r.access === "admin" || r.access === "admin (suspended)")) return false;
    if (access === "staff" && (r.appRole !== "staff" || r.access)) return false;
    if (access === "user" && (r.appRole !== "user" || r.access)) return false;
    if (verified === "yes" && !r.emailVerified) return false;
    if (verified === "no" && r.emailVerified) return false;
    if (status === "active" && (r.banned || r.pendingDeletion)) return false;
    if (status === "suspended" && !r.banned) return false;
    if (status === "pending_deletion" && !r.pendingDeletion) return false;
    if (tag && !r.tags.includes(tag)) return false;
    if (from != null && (r.createdAt ?? 0) < from) return false;
    if (to != null && (r.createdAt ?? 0) > to) return false;
    return true;
  };

  const matches: UserRow[] = [];
  let scanned = 0;
  let totalInClerk = 0;
  for (let offset = 0; offset < SCAN_CAP; offset += SCAN_PAGE) {
    const list = await client.users.getUserList({ query: q, orderBy: sort, limit: SCAN_PAGE, offset });
    totalInClerk = list.totalCount;
    const data = list.data as unknown as ClerkUserish[];
    scanned += data.length;
    for (const u of data) {
      const r = row(u);
      if (keep(r)) matches.push(r);
    }
    if (data.length < SCAN_PAGE) break;
  }
  return NextResponse.json({
    items: matches.slice((page - 1) * pageSize, page * pageSize),
    total: matches.length,
    page,
    pageSize,
    scanned,
    capped: scanned < totalInClerk,
  });
}
