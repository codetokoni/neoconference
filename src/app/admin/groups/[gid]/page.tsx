import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import GroupClient from "./group-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminGroupPage({ params }: { params: { gid: string } }) {
  if (!(await pageAllows("users:read"))) return <NoAccess permission="users:read" />;
  return <GroupClient gid={params.gid} />;
}
