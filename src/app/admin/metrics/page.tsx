import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import AdminMetricsClient from "./admin-metrics-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The /admin layout has already checked sign-in, administrator status and
// two-factor; this page needs its own permission on top.
export default async function AdminMetricsPage() {
  if (!(await pageAllows("analytics:read"))) return <NoAccess permission="analytics:read" />;
  return <AdminMetricsClient />;
}
