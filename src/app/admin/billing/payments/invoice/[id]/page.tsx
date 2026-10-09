import { pageAllows } from "@/lib/admin/context";
import { entryIdParam } from "@/lib/finance/query";
import { NoAccess } from "../../../../AdminShell";
import InvoiceClient from "./invoice-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminInvoicePage({ params }: { params: { id: string } }) {
  if (!(await pageAllows("billing:read"))) return <NoAccess permission="billing:read" />;
  return <InvoiceClient id={entryIdParam(params.id)} />;
}
