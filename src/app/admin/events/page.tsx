import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import AdminEventsClient from "./admin-events-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The /admin layout has already checked sign-in, administrator status and
// two-factor; this page needs its own permission on top.
export default async function AdminEventsPage() {
  if (!(await pageAllows("events:read"))) return <NoAccess permission="events:read" />;
  return <AdminEventsClient />;
}
