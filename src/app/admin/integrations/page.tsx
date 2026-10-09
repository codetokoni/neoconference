import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import IntegrationsClient from "./integrations-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminIntegrationsPage() {
  if (!(await pageAllows("integrations:write"))) return <NoAccess permission="integrations:write" />;
  return <IntegrationsClient />;
}
