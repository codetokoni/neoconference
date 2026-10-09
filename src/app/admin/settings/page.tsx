import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import SettingsClient from "./settings-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  if (!(await pageAllows("settings:write"))) return <NoAccess permission="settings:write" />;
  return <SettingsClient />;
}
