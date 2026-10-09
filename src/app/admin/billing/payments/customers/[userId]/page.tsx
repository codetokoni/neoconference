import { pageAllows } from "@/lib/admin/context";
import { entryIdParam } from "@/lib/finance/query";
import { NoAccess } from "../../../../AdminShell";
import CustomerClient from "./customer-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminBillingCustomerPage({ params }: { params: { userId: string } }) {
  if (!(await pageAllows("billing:read"))) return <NoAccess permission="billing:read" />;
  return <CustomerClient userId={entryIdParam(params.userId)} />;
}
