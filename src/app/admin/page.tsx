import { redirect } from "next/navigation";
import { pageAllows } from "@/lib/admin/context";
import { GoToFirstSection } from "./AdminShell";
import OverviewClient from "./overview-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Filters the Users list took when it lived at /admin. Links made then
// (bookmarks, the support desk's "/admin?q=<email>") still open it.
const USERS_LIST_PARAMS = ["q", "plan", "access", "verified", "status", "tag", "sort", "page", "pageSize", "deleted"];

// The /admin layout has already checked sign-in, administrator status and
// two-factor. The Overview needs overview:read; a role without it goes on
// to the first section it can open.
export default async function AdminHome({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  if (USERS_LIST_PARAMS.some((k) => searchParams[k] != null)) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) if (typeof v === "string") q.set(k, v);
    redirect(`/admin/users?${q.toString()}`);
  }
  if (!(await pageAllows("overview:read"))) return <GoToFirstSection />;
  return <OverviewClient />;
}
