import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import UsersClient from "./users-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The /admin layout has already checked sign-in, administrator status and
// two-factor; this page needs its own permission on top.
export default async function AdminUsersPage() {
  if (!(await pageAllows("users:read"))) return <NoAccess permission="users:read" />;
  return <UsersClient />;
}
