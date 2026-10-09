import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import AuditClient from "./audit-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The /admin layout has already checked sign-in, administrator status and
// two-factor; this page needs its own permission on top.
export default async function AdminAuditLogPage() {
  if (!(await pageAllows("audit:read"))) return <NoAccess permission="audit:read" />;
  return <AuditClient />;
}
