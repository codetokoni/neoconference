import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import SettingsClient from "./settings-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Seeing the settings needs billing:read; the API refuses changes without
// billing:settings and a fresh code.
export default async function AdminBillingSettingsPage() {
  if (!(await pageAllows("billing:read"))) return <NoAccess permission="billing:read" />;
  return <SettingsClient />;
}
