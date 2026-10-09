import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import UserClient from "./user-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminUserPage({ params }: { params: { id: string } }) {
  if (!(await pageAllows("users:read"))) return <NoAccess permission="users:read" />;
  return <UserClient id={params.id} />;
}
