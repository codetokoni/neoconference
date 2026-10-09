import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import HelpClient from "./help-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminHelpPage() {
  if (!(await pageAllows("support:read"))) return <NoAccess permission="support:read" />;
  return <HelpClient />;
}
