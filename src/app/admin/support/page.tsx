import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import DeskClient from "./desk-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The /admin layout has already checked sign-in, administrator status and
// two-factor; this page needs its own permission on top.
export default async function AdminSupportPage() {
  if (!(await pageAllows("support:read"))) return <NoAccess permission="support:read" />;
  return <DeskClient />;
}
