import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import OpsAlertsClient from "./alerts-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The /admin layout has already checked sign-in, administrator status and
// two-factor; this page needs its own permission on top.
export default async function OpsAlertsPage() {
  if (!(await pageAllows("ops:read"))) return <NoAccess permission="ops:read" />;
  return <OpsAlertsClient />;
}
