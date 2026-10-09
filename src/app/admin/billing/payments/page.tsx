import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import PaymentsClient from "./payments-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The /admin layout has already checked sign-in, administrator status and
// two-factor; this page needs its own permission on top.
export default async function AdminPaymentsPage() {
  if (!(await pageAllows("billing:read"))) return <NoAccess permission="billing:read" />;
  return <PaymentsClient />;
}
