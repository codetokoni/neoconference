import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import AutomationClient from "./automation-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminAutomationPage() {
  if (!(await pageAllows("ops:read"))) return <NoAccess permission="ops:read" />;
  return <AutomationClient />;
}
