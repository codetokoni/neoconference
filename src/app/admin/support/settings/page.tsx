import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import SlaClient from "./sla-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SupportSettingsPage() {
  if (!(await pageAllows("support:read"))) return <NoAccess permission="support:read" />;
  return <SlaClient />;
}
