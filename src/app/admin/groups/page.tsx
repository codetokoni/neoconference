import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import GroupsClient from "./groups-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminGroupsPage() {
  if (!(await pageAllows("users:read"))) return <NoAccess permission="users:read" />;
  return <GroupsClient />;
}
