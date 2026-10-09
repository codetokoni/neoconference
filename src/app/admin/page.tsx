import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "./AdminShell";
import AdminClient from "./admin-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The /admin layout has already checked sign-in, administrator status and
// two-factor; this page needs its own permission on top.
export default async function AdminPage() {
  if (!(await pageAllows("users:read"))) return <NoAccess permission="users:read" />;
  return <AdminClient />;
}
