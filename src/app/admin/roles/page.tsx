import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import RolesClient from "./roles-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminRolesPage() {
  if (!(await pageAllows("admins:read"))) return <NoAccess permission="admins:read" />;
  return <RolesClient />;
}
