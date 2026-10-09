import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import DataClient from "./data-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminDataPage() {
  if (!(await pageAllows("users:read"))) return <NoAccess permission="users:read" />;
  return <DataClient />;
}
